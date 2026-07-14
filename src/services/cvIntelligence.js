import axios from 'axios';
import { AttachmentClassification } from '@prisma/client';
import { CV_EXTRACTION_SCHEMA } from '../ai/cvExtractionSchema.js';
import { resolveCandidateCvBuffer } from './cvStorage.js';
import { extractCvText } from './cvTextExtraction.js';

const URL = 'https://api.openai.com/v1/responses';
const MODEL = process.env.OPENAI_EXTRACTION_MODEL || 'gpt-5.4-mini-2026-03-17';

function parseOutput(data = {}) {
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

function compact(value = '') {
  return String(value || '').trim();
}

function normalizeCompare(value = '') {
  return compact(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compareField(label, chatValue, cvValue) {
  const chat = normalizeCompare(chatValue);
  const cv = normalizeCompare(cvValue);
  if (!chat || !cv) return null;
  if (chat === cv || chat.includes(cv) || cv.includes(chat)) {
    return { field: label, status: 'match', chatValue, cvValue };
  }
  return { field: label, status: 'mismatch', chatValue, cvValue };
}

function compareCandidateWithCv(candidate = {}, extracted = {}) {
  return [
    compareField('Nombre', candidate.fullName, extracted.fullName),
    compareField('Documento', candidate.documentNumber, extracted.documentNumber),
    compareField('Teléfono', candidate.phone, extracted.phone),
    compareField('Localidad', candidate.locality, extracted.locality)
  ].filter(Boolean);
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'unknown_error')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access_token=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 500);
}

function failureSummary(reason = '') {
  const summaries = {
    candidate_without_cv: 'El candidato no tiene una hoja de vida almacenada.',
    cv_read_failed: 'No fue posible leer el archivo almacenado.',
    unsupported_file_type: 'Formato no compatible. La hoja de vida debe estar en PDF o DOCX.',
    missing_buffer: 'No existe contenido de archivo disponible para analizar.',
    empty_pdf_text: 'El PDF no contiene texto legible.',
    empty_docx_text: 'El DOCX no contiene texto legible.',
    text_extraction_failed: 'No fue posible extraer el texto del archivo.',
    ai_not_configured: 'La extracción inteligente no está configurada.',
    ai_no_structured_output: 'La extracción inteligente no devolvió un resultado estructurado.',
    ai_analysis_failed: 'La extracción inteligente no pudo completarse.'
  };
  return summaries[reason] || 'No fue posible completar el análisis de la hoja de vida.';
}

async function persistAttachmentAnalysis(prisma, candidate, data = {}) {
  return prisma.attachmentAnalysis.create({
    data: {
      candidateId: candidate.id,
      originalName: candidate.cvOriginalName || null,
      mimeType: candidate.cvMimeType || null,
      classification: data.classification || AttachmentClassification.OTHER,
      extractedText: data.extractedText || null,
      summary: data.summary || null,
      confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : null,
      modelUsed: data.modelUsed || null,
      rawResponse: data.rawResponse || null
    }
  });
}

async function extractCvWithAi(text = '') {
  if (!process.env.OPENAI_API_KEY) return null;

  const payload = {
    model: MODEL,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text: 'Extrae datos estructurados de una hoja de vida. No inventes datos. Si un dato no aparece de forma clara, responde null. Devuelve solo JSON bajo el schema.'
        }]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: String(text || '').slice(0, 12000) }]
      }
    ],
    text: { format: { type: 'json_schema', name: CV_EXTRACTION_SCHEMA.name, strict: CV_EXTRACTION_SCHEMA.strict, schema: CV_EXTRACTION_SCHEMA.schema } }
  };

  const response = await axios.post(URL, payload, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });

  return parseOutput(response.data);
}

export async function analyzeCandidateCv(prisma, candidateId, options = {}) {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    include: { vacancy: { select: { id: true, title: true, city: true } } }
  });

  if (!candidate) return { ok: false, reason: 'candidate_not_found' };

  let buffer;
  try {
    buffer = await resolveCandidateCvBuffer(candidate);
  } catch (error) {
    const reason = 'cv_read_failed';
    const analysis = await persistAttachmentAnalysis(prisma, candidate, {
      classification: AttachmentClassification.OTHER,
      confidence: 0,
      summary: failureSummary(reason),
      rawResponse: {
        source: 'lorren_v2_cv_analysis',
        stage: 'storage_read',
        reason,
        error: safeErrorMessage(error)
      }
    });
    return { ok: false, reason, analysis };
  }

  if (!buffer) return { ok: false, reason: 'candidate_without_cv' };

  let textResult;
  try {
    textResult = await extractCvText(buffer, {
      mimeType: candidate.cvMimeType,
      fileName: candidate.cvOriginalName
    });
  } catch (error) {
    textResult = {
      ok: false,
      text: '',
      reason: 'text_extraction_failed',
      error: safeErrorMessage(error)
    };
  }

  if (!textResult.ok) {
    const classification = textResult.reason === 'unsupported_file_type'
      ? AttachmentClassification.OTHER
      : AttachmentClassification.UNREADABLE;
    const analysis = await persistAttachmentAnalysis(prisma, candidate, {
      classification,
      confidence: 0,
      extractedText: textResult.text || null,
      summary: failureSummary(textResult.reason),
      rawResponse: {
        source: 'lorren_v2_cv_analysis',
        stage: 'text_extraction',
        reason: textResult.reason,
        error: textResult.error || null
      }
    });
    return { ok: false, reason: textResult.reason, analysis };
  }

  let extracted;
  try {
    extracted = await extractCvWithAi(textResult.text);
  } catch (error) {
    const reason = 'ai_analysis_failed';
    const analysis = await persistAttachmentAnalysis(prisma, candidate, {
      classification: AttachmentClassification.OTHER,
      confidence: 0,
      extractedText: textResult.text,
      summary: failureSummary(reason),
      modelUsed: MODEL,
      rawResponse: {
        source: 'lorren_v2_cv_analysis',
        stage: 'ai_extraction',
        reason,
        error: safeErrorMessage(error)
      }
    });
    return { ok: false, reason, analysis };
  }

  if (!extracted) {
    const reason = process.env.OPENAI_API_KEY ? 'ai_no_structured_output' : 'ai_not_configured';
    const analysis = await persistAttachmentAnalysis(prisma, candidate, {
      classification: AttachmentClassification.OTHER,
      confidence: 0,
      extractedText: textResult.text,
      summary: failureSummary(reason),
      modelUsed: process.env.OPENAI_API_KEY ? MODEL : null,
      rawResponse: {
        source: 'lorren_v2_cv_analysis',
        stage: 'ai_extraction',
        reason
      }
    });
    return { ok: false, reason, analysis };
  }

  const comparisons = compareCandidateWithCv(candidate, extracted);
  const mismatches = comparisons.filter((item) => item.status === 'mismatch');
  const confidence = Number(extracted.confidence || 0);
  const evidence = {
    source: 'lorren_v2_cv_analysis',
    generatedAt: new Date().toISOString(),
    textExtractionReason: textResult.reason,
    candidate: {
      id: candidate.id,
      phone: candidate.phone,
      fullName: candidate.fullName,
      documentNumber: candidate.documentNumber,
      vacancy: candidate.vacancy?.title || null
    },
    extracted,
    comparisons,
    mismatches,
    warnings: extracted.warnings || []
  };

  const analysis = await persistAttachmentAnalysis(prisma, candidate, {
    classification: AttachmentClassification.CV_VALID,
    confidence,
    extractedText: textResult.text,
    summary: mismatches.length
      ? `Hoja de vida analizada con ${mismatches.length} diferencia(s) frente al chat.`
      : 'Hoja de vida analizada sin diferencias detectadas frente al chat.',
    modelUsed: MODEL,
    rawResponse: evidence
  });

  return { ok: true, analysis, evidence };
}

export function parseCvAnalysisEvidence(analysis = {}) {
  const value = analysis?.rawResponse ?? analysis?.evidence ?? null;
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
