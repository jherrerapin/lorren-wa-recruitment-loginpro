import { OPENAI_ATTACHMENT_MODEL } from './openAiModelConfig.js';
import { extractCvText } from './cvTextExtraction.js';
import { detectCvDocumentMetadata } from './cvDocumentMetadata.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MODEL = OPENAI_ATTACHMENT_MODEL;
const MIN_TEXT_LENGTH = 80;

async function postResponses(payload) {
  const { default: axios } = await import('axios');
  return axios.post(RESPONSES_URL, payload, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
}

function buildResult(partial = {}) {
  return {
    attachmentKind: partial.attachmentKind || 'unknown',
    classification: partial.classification || 'UNREADABLE',
    confidence: Number(partial.confidence || 0.2),
    rationale: partial.rationale || 'insufficient_evidence',
    extractedText: partial.extractedText || '',
    evidence: partial.evidence || [],
    diagnostics: partial.diagnostics || null
  };
}

function classifyFromText(text = '', attachmentKind = 'document') {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) {
    return buildResult({
      attachmentKind,
      classification: 'UNREADABLE',
      confidence: 0.2,
      rationale: 'empty_text'
    });
  }
  if (/hoja de vida|curriculum|currículum|experiencia laboral|perfil profesional/.test(normalized)) {
    return buildResult({
      attachmentKind,
      classification: 'CV_VALID',
      confidence: 0.9,
      rationale: 'cv_keywords',
      extractedText: text,
      evidence: ['texto_cv']
    });
  }
  if (/cedula|c[eé]dula|identidad|dni|passport|pasaporte/.test(normalized)) {
    return buildResult({
      attachmentKind,
      classification: 'ID_DOC',
      confidence: 0.92,
      rationale: 'identity_keywords',
      extractedText: text,
      evidence: ['texto_id']
    });
  }
  return buildResult({
    attachmentKind,
    classification: 'OTHER',
    confidence: 0.64,
    rationale: 'non_cv_text',
    extractedText: text,
    evidence: ['texto_otro']
  });
}

function parseStructuredOutput(data = {}) {
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.parsed && typeof part.parsed === 'object') return part.parsed;
      if (typeof part?.text === 'string') {
        try { return JSON.parse(part.text); } catch {}
      }
    }
  }
  return null;
}

async function classifyWithResponses({ mimeType = '', filename = '', textHint = '', buffer = null } = {}) {
  const attachmentKind = mimeType.startsWith('image/') ? 'image' : 'document';
  if (!process.env.OPENAI_API_KEY) {
    return buildResult({
      attachmentKind,
      classification: 'UNREADABLE',
      confidence: 0.2,
      rationale: 'openai_disabled'
    });
  }

  const inputContent = [{
    type: 'input_text',
    text: `mimeType=${mimeType}; filename=${filename}; textHint=${String(textHint || '').slice(0, 1000)}`
  }];
  if (buffer && mimeType.startsWith('image/')) {
    inputContent.push({
      type: 'input_image',
      image_url: `data:${mimeType};base64,${buffer.toString('base64')}`
    });
  } else if (buffer && ['application/pdf'].includes(mimeType)) {
    inputContent.push({
      type: 'input_file',
      filename: filename || 'hoja-de-vida.pdf',
      file_data: `data:${mimeType};base64,${buffer.toString('base64')}`
    });
  }

  const payload = {
    model: MODEL,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text: 'Clasifica adjuntos para reclutamiento. Devuelve JSON estricto con: classification, confidence, rationale, evidence (array). Usa: CV_VALID|CV_IMAGE_ONLY|ID_DOC|OTHER|UNREADABLE. No inventes texto ni datos que no sean visibles en el documento.'
        }]
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
            classification: {
              type: 'string',
              enum: ['CV_VALID', 'CV_IMAGE_ONLY', 'ID_DOC', 'OTHER', 'UNREADABLE']
            },
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
    const response = await postResponses(payload);
    const parsed = parseStructuredOutput(response.data);
    return buildResult({
      attachmentKind,
      classification: parsed?.classification,
      confidence: parsed?.confidence,
      rationale: parsed?.rationale,
      evidence: parsed?.evidence
    });
  } catch {
    return buildResult({
      attachmentKind,
      classification: 'UNREADABLE',
      confidence: 0.2,
      rationale: 'responses_error'
    });
  }
}

function diagnosticsFromExtraction(textResult = {}, detected = {}) {
  return {
    detectedKind: detected.kind || textResult.detectedKind || 'unknown',
    detectedMimeType: detected.mimeType || textResult.detectedMimeType || 'application/octet-stream',
    detectionSource: detected.source || textResult.detectionSource || 'unknown',
    metadataMismatch: Boolean(detected.metadataMismatch || textResult.metadataMismatch),
    metadataConflict: Boolean(detected.metadataConflict || textResult.metadataConflict),
    extractionReason: textResult.reason || null,
    quality: textResult.quality || null
  };
}

export async function analyzeAttachment({ buffer, mimeType = '', filename = '' } = {}) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) {
    return buildResult({
      attachmentKind: 'image',
      classification: 'CV_IMAGE_ONLY',
      confidence: 0.55,
      rationale: 'image_is_not_valid_cv_attachment',
      evidence: ['image_mime_not_accepted_for_cv']
    });
  }

  const detected = detectCvDocumentMetadata(buffer, { mimeType, fileName: filename });
  if (!['pdf', 'doc', 'docx'].includes(detected.kind)) {
    return buildResult({
      attachmentKind: 'other',
      classification: 'OTHER',
      confidence: 0.5,
      rationale: 'unsupported_format',
      evidence: ['unsupported_format'],
      diagnostics: diagnosticsFromExtraction({}, detected)
    });
  }

  const textResult = await extractCvText(buffer, {
    mimeType: detected.mimeType,
    fileName: filename
  });
  const diagnostics = diagnosticsFromExtraction(textResult, detected);
  const extractedText = String(textResult.text || '');

  if (detected.kind === 'doc' && textResult.reason === 'invalid_doc_container') {
    return buildResult({
      attachmentKind: 'doc',
      classification: 'OTHER',
      confidence: 1,
      rationale: 'invalid_legacy_word_container',
      evidence: ['doc_extension_without_ole_container'],
      diagnostics
    });
  }

  const needsVisualPdf = detected.kind === 'pdf'
    && (!textResult.ok || extractedText.trim().length < MIN_TEXT_LENGTH);
  if (needsVisualPdf && process.env.OPENAI_API_KEY) {
    const ai = await classifyWithResponses({
      mimeType: detected.mimeType,
      filename,
      textHint: textResult.rawText || extractedText,
      buffer
    });
    return buildResult({
      ...ai,
      attachmentKind: detected.kind,
      extractedText: textResult.rawText || extractedText,
      diagnostics
    });
  }

  if (!textResult.ok || !extractedText.trim()) {
    return buildResult({
      attachmentKind: detected.kind,
      classification: 'UNREADABLE',
      confidence: 0.2,
      rationale: textResult.reason || 'empty_text',
      extractedText,
      evidence: ['manual_review_required'],
      diagnostics
    });
  }

  if (process.env.OPENAI_API_KEY) {
    const ai = await classifyWithResponses({
      mimeType: detected.mimeType,
      filename,
      textHint: extractedText
    });
    if (ai.classification !== 'UNREADABLE') {
      return buildResult({
        ...ai,
        attachmentKind: detected.kind,
        extractedText,
        diagnostics
      });
    }
  }

  return buildResult({
    ...classifyFromText(extractedText, detected.kind),
    attachmentKind: detected.kind,
    extractedText,
    diagnostics
  });
}
