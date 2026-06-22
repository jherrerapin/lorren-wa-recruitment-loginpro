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

  const buffer = await resolveCandidateCvBuffer(candidate);
  if (!buffer) return { ok: false, reason: 'candidate_without_cv' };

  const textResult = await extractCvText(buffer, {
    mimeType: candidate.cvMimeType,
    fileName: candidate.cvOriginalName
  });

  if (!textResult.ok) {
    const analysis = await prisma.attachmentAnalysis.create({
      data: {
        candidateId,
        classification: AttachmentClassification.UNREADABLE,
        confidence: 0,
        evidence: JSON.stringify({ reason: textResult.reason, source: 'loren_v2_cv_analysis' }),
        mimeType: candidate.cvMimeType,
        fileName: candidate.cvOriginalName
      }
    });
    return { ok: false, reason: textResult.reason, analysis };
  }

  const extracted = await extractCvWithAi(textResult.text);
  if (!extracted) return { ok: false, reason: 'ai_not_configured_or_failed' };

  const comparisons = compareCandidateWithCv(candidate, extracted);
  const mismatches = comparisons.filter((item) => item.status === 'mismatch');
  const confidence = Number(extracted.confidence || 0);
  const evidence = {
    source: 'loren_v2_cv_analysis',
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

  const analysis = await prisma.attachmentAnalysis.create({
    data: {
      candidateId,
      classification: AttachmentClassification.CV_VALID,
      confidence,
      evidence: JSON.stringify(evidence),
      mimeType: candidate.cvMimeType,
      fileName: candidate.cvOriginalName
    }
  });

  return { ok: true, analysis, evidence };
}

export function parseCvAnalysisEvidence(analysis = {}) {
  try {
    return JSON.parse(analysis?.evidence || '{}');
  } catch {
    return {};
  }
}
