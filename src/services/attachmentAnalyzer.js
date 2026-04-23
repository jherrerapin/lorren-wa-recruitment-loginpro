import axios from 'axios';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MODEL = 'gpt-5.4-mini-2026-03-17';
const MIN_TEXT_LENGTH = 80;

function buildResult(partial = {}) {
  return {
    attachmentKind: partial.attachmentKind || 'unknown',
    classification: partial.classification || 'UNREADABLE',
    confidence: Number(partial.confidence || 0.2),
    rationale: partial.rationale || 'insufficient_evidence',
    extractedText: partial.extractedText || '',
    evidence: partial.evidence || []
  };
}

function classifyFromText(text = '', attachmentKind = 'document') {
  const n = String(text || '').toLowerCase();
  if (!n.trim()) {
    return buildResult({ attachmentKind, classification: 'UNREADABLE', confidence: 0.2, rationale: 'empty_text' });
  }
  if (/hoja de vida|curriculum|currículum|experiencia laboral|perfil profesional/.test(n)) {
    return buildResult({ attachmentKind, classification: 'CV_VALID', confidence: 0.9, rationale: 'cv_keywords', extractedText: text, evidence: ['texto_cv'] });
  }
  if (/cedula|c[eé]dula|identidad|dni|passport|pasaporte/.test(n)) {
    return buildResult({ attachmentKind, classification: 'ID_DOC', confidence: 0.92, rationale: 'identity_keywords', extractedText: text, evidence: ['texto_id'] });
  }
  return buildResult({ attachmentKind, classification: 'OTHER', confidence: 0.64, rationale: 'non_cv_text', extractedText: text, evidence: ['texto_otro'] });
}

function parseStructuredOutput(data = {}) {
  const output = data?.output || [];
  for (const item of output) {
    for (const part of item?.content || []) {
      if (part?.parsed && typeof part.parsed === 'object') return part.parsed;
      if (typeof part?.text === 'string') {
        try { return JSON.parse(part.text); } catch {}
      }
    }
  }
  return null;
}

async function classifyWithResponses({ mimeType = '', filename = '', textHint = '', base64 = null } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    return buildResult({
      attachmentKind: mimeType.startsWith('image/') ? 'image' : 'document',
      classification: 'UNREADABLE',
      confidence: 0.2,
      rationale: 'openai_disabled'
    });
  }

  const inputContent = [{ type: 'input_text', text: `mimeType=${mimeType}; filename=${filename}; textHint=${String(textHint || '').slice(0, 1000)}` }];
  if (base64 && mimeType.startsWith('image/')) {
    inputContent.push({ type: 'input_image', image_url: `data:${mimeType};base64,${base64}` });
  }

  const payload = {
    model: MODEL,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: 'Clasifica adjuntos para reclutamiento. Devuelve JSON estricto con: classification, confidence, rationale, evidence (array). Usa: CV_VALID|CV_IMAGE_ONLY|ID_DOC|OTHER|UNREADABLE.' }]
      },
      { role: 'user', content: inputContent }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'attachment_classifier',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            classification: { type: 'string', enum: ['CV_VALID', 'CV_IMAGE_ONLY', 'ID_DOC', 'OTHER', 'UNREADABLE'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            rationale: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } }
          },
          required: ['classification', 'confidence', 'rationale', 'evidence']
        }
      }
    }
  };

  try {
    const response = await axios.post(RESPONSES_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    const parsed = parseStructuredOutput(response.data);
    return buildResult({
      attachmentKind: mimeType.startsWith('image/') ? 'image' : 'document',
      classification: parsed?.classification,
      confidence: parsed?.confidence,
      rationale: parsed?.rationale,
      evidence: parsed?.evidence
    });
  } catch {
    return buildResult({ attachmentKind: mimeType.startsWith('image/') ? 'image' : 'document', classification: 'UNREADABLE', confidence: 0.2, rationale: 'responses_error' });
  }
}

export async function analyzeAttachment({ buffer, mimeType = '', filename = '' } = {}) {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();

  if (mime.startsWith('image/')) {
    const base64 = buffer ? Buffer.from(buffer).toString('base64') : null;
    return classifyWithResponses({ mimeType: mime, filename: name, base64 });
  }

  if (mime.includes('pdf') || name.endsWith('.pdf')) {
    const parsed = await pdfParse(buffer).catch(() => ({ text: '' }));
    const text = String(parsed?.text || '').slice(0, 6000);
    if (text.trim().length >= MIN_TEXT_LENGTH) return classifyFromText(text, 'pdf');
    const fallback = await classifyWithResponses({ mimeType: mime || 'application/pdf', filename: name, textHint: text });
    return buildResult({ ...fallback, attachmentKind: 'pdf', extractedText: text });
  }

  if (mime.includes('word') || name.endsWith('.docx') || name.endsWith('.doc')) {
    const parsed = await mammoth.extractRawText({ buffer }).catch(() => ({ value: '' }));
    const text = String(parsed?.value || '').slice(0, 6000);
    return classifyFromText(text, 'doc');
  }

  return buildResult({ attachmentKind: 'other', classification: 'OTHER', confidence: 0.5, rationale: 'unsupported_format', evidence: ['unsupported_format'] });
}
