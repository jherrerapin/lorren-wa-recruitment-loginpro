import axios from 'axios';
import crypto from 'node:crypto';
import { CV_EXTRACTION_SCHEMA } from '../ai/cvExtractionSchema.js';
import { resolveCandidateCvBuffer } from './cvStorage.js';
import { extractCvText } from './cvTextExtraction.js';
import { OPENAI_CV_MODEL } from './openAiModelConfig.js';
import { normalizeTransportMode } from './transportMode.js';
import { safeErrorMessage } from './errorSanitization.js';

export { safeErrorMessage };

const AttachmentClassification = Object.freeze({
  CV_VALID: 'CV_VALID',
  OTHER: 'OTHER',
  UNREADABLE: 'UNREADABLE'
});
const URL = 'https://api.openai.com/v1/responses';
const MODEL = OPENAI_CV_MODEL;
const MAX_CANDIDATES_PER_REVIEW = 120;
const MATCH_BATCH_SIZE = 12;
const MATCH_BATCH_RETRY_LIMIT = 1;
const MAX_INDIVIDUAL_MATCH_RETRIES = 3;
const VISUAL_CONFIDENCE_THRESHOLD = 0.5;
const MIN_USEFUL_PDF_TEXT_LENGTH = 80;
const REVIEW_CACHE_TTL_MS = 5 * 60 * 1000;
const REVIEW_CACHE_MAX_ENTRIES = 100;
const profileInterpretationCache = new Map();
const candidateComparisonCache = new Map();
const ELIGIBLE_CANDIDATE_STATUSES = ['REGISTRADO', 'CONTACTADO', 'APROBADO'];
const MAX_MATCH_EXPERIENCES = 5;
const MAX_MATCH_RESPONSIBILITIES = 4;
const MAX_MATCH_SKILLS = 15;
const MAX_MATCH_CERTIFICATIONS = 10;

const CV_REVIEW_EXTRACTION_SCHEMA = {
  ...CV_EXTRACTION_SCHEMA,
  name: 'loren_cv_review_extraction',
  schema: {
    ...CV_EXTRACTION_SCHEMA.schema,
    properties: {
      ...CV_EXTRACTION_SCHEMA.schema.properties,
      skills: { type: 'array', items: { type: 'string' } },
      certifications: { type: 'array', items: { type: 'string' } },
      estimatedExperienceMonths: { type: ['number', 'null'], minimum: 0 },
      experience: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: ['string', 'null'] },
            company: { type: ['string', 'null'] },
            duration: { type: ['string', 'null'] },
            responsibilities: { type: 'array', items: { type: 'string' } }
          },
          required: ['role', 'company', 'duration', 'responsibilities']
        }
      }
    },
    required: [
      ...CV_EXTRACTION_SCHEMA.schema.required,
      'skills',
      'certifications',
      'estimatedExperienceMonths',
      'experience'
    ]
  }
};

const DESIRED_PROFILE_SCHEMA = {
  name: 'loren_desired_candidate_profile',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'string', enum: ['REQUIRED', 'PREFERRED'] },
            minimumMonths: { type: ['number', 'null'], minimum: 0 },
            keywords: { type: 'array', items: { type: 'string' } }
          },
          required: ['id', 'label', 'description', 'priority', 'minimumMonths', 'keywords']
        }
      },
      warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['summary', 'criteria', 'warnings']
  }
};

const CANDIDATE_MATCH_SCHEMA = {
  name: 'loren_candidate_profile_matches',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            candidateId: { type: 'string' },
            level: { type: 'string', enum: ['STRONG', 'POSSIBLE', 'LOW'] },
            score: { type: 'number', minimum: 0, maximum: 100 },
            reasons: {
              type: 'array',
              minItems: 0,
              maxItems: 4,
              items: { type: 'string', maxLength: 320 }
            },
            evidence: {
              type: 'array',
              minItems: 0,
              maxItems: 5,
              items: { type: 'string', maxLength: 320 }
            },
            gaps: {
              type: 'array',
              minItems: 0,
              maxItems: 4,
              items: { type: 'string', maxLength: 320 }
            }
          },
          required: ['candidateId', 'level', 'score', 'reasons', 'evidence', 'gaps']
        }
      }
    },
    required: ['results']
  }
};

function candidateMatchSchema(candidateIds = []) {
  const allowedIds = candidateIds.map(compact).filter(Boolean);
  return {
    ...CANDIDATE_MATCH_SCHEMA,
    schema: {
      ...CANDIDATE_MATCH_SCHEMA.schema,
      properties: {
        ...CANDIDATE_MATCH_SCHEMA.schema.properties,
        results: {
          ...CANDIDATE_MATCH_SCHEMA.schema.properties.results,
          minItems: allowedIds.length,
          maxItems: allowedIds.length,
          items: {
            ...CANDIDATE_MATCH_SCHEMA.schema.properties.results.items,
            properties: {
              ...CANDIDATE_MATCH_SCHEMA.schema.properties.results.items.properties,
              candidateId: { type: 'string', enum: allowedIds }
            }
          }
        }
      }
    }
  };
}

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

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableJsonValue(value[key]);
      return result;
    }, {});
}

function reviewCacheKey(scope, payload) {
  const serialized = JSON.stringify(stableJsonValue(payload));
  return crypto.createHash('sha256').update(`${scope}:${serialized}`).digest('hex');
}

function cleanText(value, maxLength = 320) {
  const text = compact(value).replace(/\s+/g, ' ');
  return text ? text.slice(0, maxLength) : null;
}

function withoutEmptyValues(value) {
  if (Array.isArray(value)) {
    return value
      .map(withoutEmptyValues)
      .filter((item) => item !== null && item !== undefined && item !== '');
  }
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((result, [key, item]) => {
    const cleaned = withoutEmptyValues(item);
    const emptyObject = cleaned && typeof cleaned === 'object'
      && !Array.isArray(cleaned)
      && Object.keys(cleaned).length === 0;
    if (cleaned === null || cleaned === undefined || cleaned === '' || emptyObject) return result;
    result[key] = cleaned;
    return result;
  }, {});
}

function usageNumbers(usage = {}) {
  return {
    inputTokens: Number(usage.input_tokens || 0),
    cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens || 0),
    cacheWriteTokens: Number(usage.input_tokens_details?.cache_write_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
    reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0)
  };
}

async function persistAnalysisUsage(prisma, usage, context = {}) {
  if (!usage) return;
  const values = usageNumbers(usage);
  const data = {
    stage: compact(context.stage) || 'unknown',
    vacancyId: compact(context.vacancyId) || null,
    candidateCount: Math.max(0, Number(context.candidateCount || 0)),
    modelUsed: compact(context.modelUsed) || MODEL,
    ...values
  };
  try {
    if (prisma?.cvAnalysisUsage?.create) {
      await prisma.cvAnalysisUsage.create({ data });
    } else if (prisma?.$executeRawUnsafe) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "CvAnalysisUsage"
          ("id", "stage", "vacancyId", "candidateCount", "modelUsed", "inputTokens",
           "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens",
           "totalTokens", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
        crypto.randomUUID(),
        data.stage,
        data.vacancyId,
        data.candidateCount,
        data.modelUsed,
        data.inputTokens,
        data.cachedInputTokens,
        data.cacheWriteTokens,
        data.outputTokens,
        data.reasoningTokens,
        data.totalTokens
      );
    }
  } catch {
    // La medición nunca debe impedir el análisis principal.
  }
}

function parseStoredJson(value, fallback = []) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function validStoredMatch(row = {}, expectedCandidateId = '') {
  const candidateId = compact(row.candidateId);
  const level = compact(row.level);
  return candidateId === compact(expectedCandidateId)
    && ['STRONG', 'POSSIBLE', 'LOW'].includes(level)
    && Number.isFinite(Number(row.score))
    && Array.isArray(parseStoredJson(row.reasons))
    && Array.isArray(parseStoredJson(row.evidence))
    && Array.isArray(parseStoredJson(row.gaps));
}

function storedMatch(row = {}) {
  return normalizeMatch({
    candidateId: row.candidateId,
    level: row.level,
    score: row.score,
    reasons: parseStoredJson(row.reasons),
    evidence: parseStoredJson(row.evidence),
    gaps: parseStoredJson(row.gaps)
  });
}

async function readStoredProfile(prisma, fingerprint) {
  try {
    let row = null;
    if (prisma?.cvReviewProfile?.findUnique) {
      row = await prisma.cvReviewProfile.findUnique({ where: { fingerprint } });
    } else if (prisma?.$queryRawUnsafe) {
      [row] = await prisma.$queryRawUnsafe(
        'SELECT "interpretedProfile" FROM "CvReviewProfile" WHERE "fingerprint" = $1 LIMIT 1',
        fingerprint
      );
    }
    const profile = parseStoredJson(row?.interpretedProfile, null);
    return isValidInterpretedProfile(profile) ? cloneJson(profile) : null;
  } catch {
    return null;
  }
}

async function writeStoredProfile(prisma, { fingerprint, vacancyId, modelUsed, interpretedProfile }) {
  if (!isValidInterpretedProfile(interpretedProfile)) return;
  try {
    if (prisma?.cvReviewProfile?.upsert) {
      await prisma.cvReviewProfile.upsert({
        where: { fingerprint },
        create: { fingerprint, vacancyId, modelUsed, interpretedProfile },
        update: { modelUsed, interpretedProfile }
      });
    } else if (prisma?.$executeRawUnsafe) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "CvReviewProfile"
          ("id", "fingerprint", "vacancyId", "modelUsed", "interpretedProfile", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
         ON CONFLICT ("fingerprint") DO UPDATE
         SET "modelUsed" = EXCLUDED."modelUsed",
             "interpretedProfile" = EXCLUDED."interpretedProfile",
             "updatedAt" = NOW()`,
        crypto.randomUUID(),
        fingerprint,
        vacancyId,
        modelUsed,
        JSON.stringify(interpretedProfile)
      );
    }
  } catch {
    // Compatibilidad durante despliegue gradual de la migración.
  }
}

async function readStoredComparisons(prisma, entries = []) {
  const result = new Map();
  if (!entries.length) return result;
  const fingerprints = entries.map((entry) => entry.fingerprint);
  try {
    let rows = [];
    if (prisma?.cvCandidateComparison?.findMany) {
      rows = await prisma.cvCandidateComparison.findMany({
        where: { fingerprint: { in: fingerprints } }
      });
    } else if (prisma?.$queryRawUnsafe) {
      const placeholders = fingerprints.map((_, index) => `$${index + 1}`).join(', ');
      rows = await prisma.$queryRawUnsafe(
        `SELECT "fingerprint", "candidateId", "level", "score", "reasons", "evidence", "gaps"
         FROM "CvCandidateComparison"
         WHERE "fingerprint" IN (${placeholders})`,
        ...fingerprints
      );
    }
    const expectedByFingerprint = new Map(entries.map((entry) => [
      entry.fingerprint,
      entry.item.candidate.id
    ]));
    for (const row of rows || []) {
      const expectedCandidateId = expectedByFingerprint.get(row.fingerprint);
      if (!expectedCandidateId || !validStoredMatch(row, expectedCandidateId)) continue;
      result.set(expectedCandidateId, storedMatch(row));
    }
  } catch {
    return new Map();
  }
  return result;
}

async function writeStoredComparisons(prisma, entries = [], matches = []) {
  if (!entries.length || !matches.length) return;
  const entryByCandidate = new Map(entries.map((entry) => [entry.item.candidate.id, entry]));
  for (const match of matches) {
    const entry = entryByCandidate.get(match.candidateId);
    if (!entry || !validStoredMatch(match, match.candidateId)) continue;
    const data = {
      fingerprint: entry.fingerprint,
      candidateId: match.candidateId,
      vacancyId: entry.item.candidate.vacancyId || null,
      modelUsed: entry.modelUsed,
      level: match.level,
      score: match.score,
      reasons: match.reasons,
      evidence: match.evidence,
      gaps: match.gaps
    };
    try {
      if (prisma?.cvCandidateComparison?.upsert) {
        await prisma.cvCandidateComparison.upsert({
          where: { fingerprint: entry.fingerprint },
          create: data,
          update: {
            level: data.level,
            score: data.score,
            reasons: data.reasons,
            evidence: data.evidence,
            gaps: data.gaps,
            modelUsed: data.modelUsed
          }
        });
      } else if (prisma?.$executeRawUnsafe) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "CvCandidateComparison"
            ("id", "fingerprint", "candidateId", "vacancyId", "modelUsed", "level", "score",
             "reasons", "evidence", "gaps", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, NOW(), NOW())
           ON CONFLICT ("fingerprint") DO UPDATE
           SET "level" = EXCLUDED."level",
               "score" = EXCLUDED."score",
               "reasons" = EXCLUDED."reasons",
               "evidence" = EXCLUDED."evidence",
               "gaps" = EXCLUDED."gaps",
               "modelUsed" = EXCLUDED."modelUsed",
               "updatedAt" = NOW()`,
          crypto.randomUUID(),
          data.fingerprint,
          data.candidateId,
          data.vacancyId,
          data.modelUsed,
          data.level,
          data.score,
          JSON.stringify(data.reasons),
          JSON.stringify(data.evidence),
          JSON.stringify(data.gaps)
        );
      }
    } catch {
      // Una falla de persistencia no invalida el resultado ya obtenido.
    }
  }
}

function readReviewCache(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return cloneJson(entry.value);
}

function writeReviewCache(cache, key, value) {
  if (value === null || value === undefined) return;
  cache.delete(key);
  cache.set(key, {
    expiresAt: Date.now() + REVIEW_CACHE_TTL_MS,
    value: cloneJson(value)
  });
  while (cache.size > REVIEW_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

export function clearCvIntelligenceCachesForTest() {
  profileInterpretationCache.clear();
  candidateComparisonCache.clear();
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

function failureSummary(reason = '') {
  const summaries = {
    candidate_without_cv: 'El candidato no tiene una hoja de vida almacenada.',
    cv_read_failed: 'No fue posible leer el archivo almacenado.',
    unsupported_file_type: 'Formato no compatible. La hoja de vida debe estar en PDF o DOCX.',
    missing_buffer: 'No existe contenido de archivo disponible para analizar.',
    empty_pdf_text: 'El PDF no contiene texto legible y necesita revisión manual.',
    empty_docx_text: 'El DOCX no contiene texto legible.',
    text_extraction_failed: 'No fue posible extraer el texto del archivo.',
    ai_not_configured: 'La extracción inteligente no está configurada.',
    ai_no_structured_output: 'La extracción inteligente no devolvió un resultado estructurado.',
    ai_analysis_failed: 'La extracción inteligente no pudo completarse.',
    visual_analysis_failed: 'No fue posible leer visualmente el PDF.',
    visual_no_structured_output: 'La lectura visual no encontró información suficiente.',
    low_visual_confidence: 'La lectura visual no fue suficientemente clara; conviene revisar el archivo manualmente.',
    profile_too_short: 'Describe con un poco más de detalle el perfil que necesitas.',
    profile_analysis_failed: 'No fue posible interpretar el perfil buscado.',
    match_analysis_failed: 'No fue posible comparar los perfiles en este momento.'
  };
  return summaries[reason] || 'No fue posible completar el análisis de la hoja de vida.';
}

function isOpenAiAvailable(options = {}) {
  return Boolean(options.openAiPost || process.env.OPENAI_API_KEY);
}

function selectedModel(options = {}) {
  return compact(options.model) || MODEL;
}

function candidateCvReference(candidate = {}) {
  const storageKey = compact(candidate.cvStorageKey);
  if (storageKey) return `storage:${storageKey}`;
  if (!candidate.cvData) return null;
  const buffer = Buffer.isBuffer(candidate.cvData) ? candidate.cvData : Buffer.from(candidate.cvData);
  return `inline:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

async function requestStructuredOutput({ schema, systemText, userContent }, options = {}) {
  if (!isOpenAiAvailable(options)) return null;
  const modelUsed = selectedModel(options);
  const payload = {
    model: modelUsed,
    prompt_cache_key: reviewCacheKey('openai-prefix', {
      model: modelUsed,
      schema: schema.name
    }),
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: systemText }]
      },
      {
        role: 'user',
        content: Array.isArray(userContent)
          ? userContent
          : [{ type: 'input_text', text: String(userContent || '') }]
      }
    ],
    reasoning: { effort: 'low' },
    text: {
      format: {
        type: 'json_schema',
        name: schema.name,
        strict: schema.strict,
        schema: schema.schema
      }
    }
  };

  const response = options.openAiPost
    ? await options.openAiPost(payload)
    : await axios.post(URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: Number(process.env.OPENAI_CV_TIMEOUT_MS || 45000)
    });

  const responseData = response?.data || response;
  await persistAnalysisUsage(options.prisma, responseData?.usage, {
    stage: options.usageStage,
    vacancyId: options.usageVacancyId,
    candidateCount: options.usageCandidateCount,
    modelUsed
  });
  return parseOutput(responseData);
}

async function persistAttachmentAnalysis(prisma, candidate, data = {}) {
  const analysisData = {
    candidateId: candidate.id,
    originalName: candidate.cvOriginalName || null,
    mimeType: candidate.cvMimeType || null,
    classification: data.classification || AttachmentClassification.OTHER,
    extractedText: data.extractedText || null,
    summary: data.summary || null,
    confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : null,
    modelUsed: data.modelUsed || null
  };

  if (data.rawResponse !== undefined && data.rawResponse !== null) {
    analysisData.rawResponse = data.rawResponse;
  }

  return prisma.attachmentAnalysis.create({ data: analysisData });
}

async function extractCvWithAi({ text = '', buffer = null, mimeType = '', fileName = '' } = {}, options = {}) {
  const systemText = `Extrae información comprobable de una hoja de vida para apoyar una revisión humana.
No inventes datos ni deduzcas información que no esté en el documento.
Resume experiencia, cargos, duración, responsabilidades, estudios, habilidades y certificaciones.
Si una fecha o duración no es clara, conserva el texto original y usa null cuando corresponda.
Las advertencias deben explicar problemas reales de lectura o información ambigua.`;

  const userContent = buffer
    ? [{
      type: 'input_file',
      filename: compact(fileName) || 'hoja-de-vida.pdf',
      file_data: `data:${compact(mimeType) || 'application/pdf'};base64,${buffer.toString('base64')}`,
      detail: 'high'
    }]
    : [{ type: 'input_text', text: String(text || '').slice(0, 30000) }];

  return requestStructuredOutput({
    schema: CV_REVIEW_EXTRACTION_SCHEMA,
    systemText,
    userContent
  }, options);
}

export function shouldUseVisualPdfFallback(candidate = {}, textResult = {}) {
  const mime = compact(candidate.cvMimeType).toLowerCase();
  const name = compact(candidate.cvOriginalName).toLowerCase();
  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
  if (!isPdf) return false;
  if (textResult?.ok === false) {
    return ['empty_pdf_text', 'text_extraction_failed'].includes(textResult?.reason);
  }
  return compact(textResult?.text).length < MIN_USEFUL_PDF_TEXT_LENGTH;
}

function buildEvidence(candidate, extracted, textResult, extractionMode) {
  const comparisons = compareCandidateWithCv(candidate, extracted);
  const mismatches = comparisons.filter((item) => item.status === 'mismatch');
  return {
    source: 'lorren_v2_cv_analysis',
    generatedAt: new Date().toISOString(),
    documentReference: candidateCvReference(candidate),
    extractionMode,
    textExtractionReason: textResult?.reason || null,
    candidate: {
      id: candidate.id,
      vacancy: candidate.vacancy?.title || null
    },
    extracted,
    comparisons,
    mismatches,
    warnings: extracted.warnings || []
  };
}

export async function analyzeCandidateCv(prisma, candidateId, options = {}) {
  const modelUsed = selectedModel(options);
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

  const visualFallback = shouldUseVisualPdfFallback(candidate, textResult);
  if (!textResult.ok && !visualFallback) {
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

  if (!isOpenAiAvailable(options)) {
    const reason = visualFallback ? (textResult.reason || 'empty_pdf_text') : 'ai_not_configured';
    const analysis = await persistAttachmentAnalysis(prisma, candidate, {
      classification: visualFallback ? AttachmentClassification.UNREADABLE : AttachmentClassification.OTHER,
      confidence: 0,
      extractedText: textResult.text || null,
      summary: failureSummary(reason),
      rawResponse: {
        source: 'lorren_v2_cv_analysis',
        stage: visualFallback ? 'visual_fallback' : 'ai_extraction',
        reason
      }
    });
    return { ok: false, reason, analysis };
  }

  let extracted;
  try {
    const extractionOptions = {
      ...options,
      prisma,
      usageStage: 'cv_extraction',
      usageVacancyId: candidate.vacancyId,
      usageCandidateCount: 1
    };
    extracted = visualFallback
      ? await extractCvWithAi({
        buffer,
        mimeType: candidate.cvMimeType,
        fileName: candidate.cvOriginalName
      }, extractionOptions)
      : await extractCvWithAi({ text: textResult.text }, extractionOptions);
  } catch (error) {
    const reason = visualFallback ? 'visual_analysis_failed' : 'ai_analysis_failed';
    const analysis = await persistAttachmentAnalysis(prisma, candidate, {
      classification: visualFallback ? AttachmentClassification.UNREADABLE : AttachmentClassification.OTHER,
      confidence: 0,
      extractedText: textResult.text || null,
      summary: failureSummary(reason),
      modelUsed,
      rawResponse: {
        source: 'lorren_v2_cv_analysis',
        stage: visualFallback ? 'visual_fallback' : 'ai_extraction',
        reason,
        error: safeErrorMessage(error)
      }
    });
    return { ok: false, reason, analysis };
  }

  if (!extracted) {
    const reason = visualFallback ? 'visual_no_structured_output' : 'ai_no_structured_output';
    const analysis = await persistAttachmentAnalysis(prisma, candidate, {
      classification: visualFallback ? AttachmentClassification.UNREADABLE : AttachmentClassification.OTHER,
      confidence: 0,
      extractedText: textResult.text || null,
      summary: failureSummary(reason),
      modelUsed,
      rawResponse: {
        source: 'lorren_v2_cv_analysis',
        stage: visualFallback ? 'visual_fallback' : 'ai_extraction',
        reason
      }
    });
    return { ok: false, reason, analysis };
  }

  const confidence = Number(extracted.confidence || 0);
  const evidence = buildEvidence(candidate, extracted, textResult, visualFallback ? 'visual_pdf' : 'document_text');

  if (visualFallback && confidence < VISUAL_CONFIDENCE_THRESHOLD) {
    const reason = 'low_visual_confidence';
    const analysis = await persistAttachmentAnalysis(prisma, candidate, {
      classification: AttachmentClassification.UNREADABLE,
      confidence,
      summary: failureSummary(reason),
      modelUsed,
      rawResponse: { ...evidence, stage: 'visual_fallback', reason }
    });
    return { ok: false, reason, analysis, evidence };
  }

  const analysis = await persistAttachmentAnalysis(prisma, candidate, {
    classification: AttachmentClassification.CV_VALID,
    confidence,
    extractedText: textResult.text || null,
    summary: evidence.mismatches.length
      ? `Hoja de vida analizada con ${evidence.mismatches.length} diferencia(s) frente al chat.`
      : visualFallback
        ? 'Hoja de vida leída desde las imágenes del PDF.'
        : 'Hoja de vida analizada sin diferencias detectadas frente al chat.',
    modelUsed,
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

function latestUsableAnalysis(candidate = {}) {
  const latest = Array.isArray(candidate.attachmentAnalyses) ? candidate.attachmentAnalyses[0] : null;
  if (!latest || latest.classification !== AttachmentClassification.CV_VALID) return null;
  const evidence = parseCvAnalysisEvidence(latest);
  const currentReference = candidateCvReference(candidate);
  if (!currentReference || evidence?.documentReference !== currentReference) return null;
  return evidence?.extracted && typeof evidence.extracted === 'object' ? latest : null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function candidateForMatching(candidate, analysis) {
  const extracted = parseCvAnalysisEvidence(analysis).extracted || {};
  const registeredTransport = normalizeTransportMode(candidate.transportMode)
    || cleanText(candidate.transportMode, 80);
  const registeredResidence = cleanText(
    candidate.locality || candidate.neighborhood || candidate.zone,
    160
  );
  const experience = Array.isArray(extracted.experience)
    ? extracted.experience.slice(0, MAX_MATCH_EXPERIENCES).map((item) => withoutEmptyValues({
      role: cleanText(item?.role, 160),
      company: cleanText(item?.company, 160),
      duration: cleanText(item?.duration, 100),
      responsibilities: Array.isArray(item?.responsibilities)
        ? item.responsibilities
          .map((value) => cleanText(value, 240))
          .filter(Boolean)
          .slice(0, MAX_MATCH_RESPONSIBILITIES)
        : []
    }))
    : [];

  return withoutEmptyValues({
    candidateId: candidate.id,
    sources: {
      cv: {
        confidence: Number(analysis.confidence || 0),
        city: cleanText(extracted.city, 120),
        locality: cleanText(extracted.locality, 160),
        experienceSummary: cleanText(extracted.experienceSummary, 900),
        lastRole: cleanText(extracted.lastRole, 180),
        educationSummary: cleanText(extracted.educationSummary, 600),
        estimatedExperienceMonths: extracted.estimatedExperienceMonths ?? null,
        skills: Array.isArray(extracted.skills)
          ? extracted.skills.map((value) => cleanText(value, 120)).filter(Boolean).slice(0, MAX_MATCH_SKILLS)
          : [],
        certifications: Array.isArray(extracted.certifications)
          ? extracted.certifications
            .map((value) => cleanText(value, 160))
            .filter(Boolean)
            .slice(0, MAX_MATCH_CERTIFICATIONS)
          : [],
        experience
      },
      registration: {
        transportMode: registeredTransport,
        residence: registeredResidence
      }
    }
  });
}

function isValidInterpretedProfile(profile) {
  return Boolean(
    profile
    && typeof profile === 'object'
    && typeof profile.summary === 'string'
    && Array.isArray(profile.criteria)
    && Array.isArray(profile.warnings)
  );
}

async function interpretDesiredProfile(prisma, vacancy, desiredProfile, options = {}) {
  const model = selectedModel(options);
  const normalizedRequest = compact(desiredProfile).replace(/\s+/g, ' ');
  const cacheKey = reviewCacheKey('profile', {
    model,
    vacancy: {
      id: vacancy.id || null,
      title: vacancy.title || null,
      city: vacancy.city || null,
      requirements: vacancy.requirements || null,
      roleDescription: vacancy.roleDescription || null
    },
    coordinatorRequest: normalizedRequest
  });
  const cached = readReviewCache(profileInterpretationCache, cacheKey);
  if (cached) return cached;

  const stored = await readStoredProfile(prisma, cacheKey);
  if (stored) {
    writeReviewCache(profileInterpretationCache, cacheKey, stored);
    return stored;
  }

  const interpreted = await requestStructuredOutput({
    schema: DESIRED_PROFILE_SCHEMA,
    systemText: `Convierte la información de una vacante y el complemento escrito por el coordinador en criterios claros para revisar perfiles.
Los requisitos y la descripción de la vacante son la base del perfil y no deben desaparecer.
La solicitud del coordinador complementa, precisa o prioriza esa base, pero no la reemplaza silenciosamente.
Interpreta el significado y el contexto: considera sinónimos, funciones equivalentes y experiencia transferible cuando la evidencia lo permita.
No exijas coincidencias literales de palabras ni conviertas la lista de keywords en una búsqueda exacta.
No agregues requisitos que no aparezcan en la vacante ni en la solicitud del coordinador.
Separa lo indispensable de lo deseable. Si un tiempo mínimo no está claro, usa null.
No uses nombre, género, edad, fotografía ni otros rasgos personales como criterios.
Escribe etiquetas y explicaciones fáciles de entender.`,
    userContent: JSON.stringify({
      vacancy: {
        title: vacancy.title || null,
        city: vacancy.city || null,
        requirements: vacancy.requirements || null,
        roleDescription: vacancy.roleDescription || null
      },
      coordinatorRequest: normalizedRequest
    })
  }, {
    ...options,
    prisma,
    usageStage: 'profile_interpretation',
    usageVacancyId: vacancy.id,
    usageCandidateCount: 0
  });

  if (isValidInterpretedProfile(interpreted)) {
    writeReviewCache(profileInterpretationCache, cacheKey, interpreted);
    await writeStoredProfile(prisma, {
      fingerprint: cacheKey,
      vacancyId: vacancy.id,
      modelUsed: model,
      interpretedProfile: interpreted
    });
  }
  return interpreted;
}

function buildComparisonProfile(vacancy, desiredProfile, interpretedProfile) {
  return {
    vacancy: {
      id: vacancy.id || null,
      title: vacancy.title || null,
      city: vacancy.city || null,
      requirements: vacancy.requirements || null,
      roleDescription: vacancy.roleDescription || null
    },
    coordinatorRequest: desiredProfile,
    interpretedProfile
  };
}

function completeMatchResponse(response, candidateIds = []) {
  if (!Array.isArray(response?.results) || response.results.length !== candidateIds.length) return false;
  const expected = new Set(candidateIds.map(compact).filter(Boolean));
  const found = new Set();
  for (const result of response.results) {
    const candidateId = compact(result?.candidateId);
    if (!expected.has(candidateId) || found.has(candidateId)) return false;
    found.add(candidateId);
  }
  return found.size === expected.size;
}

async function matchCandidateBatch(prisma, comparisonProfile, candidates, options = {}) {
  const candidateIds = candidates.map((candidate) => compact(candidate.candidateId)).filter(Boolean);
  const model = selectedModel(options);
  const cacheKey = reviewCacheKey('matches', {
    model,
    comparisonProfile,
    candidates
  });
  const cached = readReviewCache(candidateComparisonCache, cacheKey);
  if (cached) return cached;

  const response = await requestStructuredOutput({
    schema: candidateMatchSchema(candidateIds),
    systemText: `Compara la información disponible de cada candidato con el perfil buscado para apoyar a un coordinador humano.
El perfil contiene la vacante original, el complemento del coordinador y una interpretación estructurada.
Los requisitos y la descripción de la vacante son la base. El texto del coordinador los complementa, precisa o prioriza; no los sustituye silenciosamente.
Evalúa por significado y contexto, no por coincidencia literal de palabras. Reconoce sinónimos, responsabilidades equivalentes y experiencia transferible cuando estén respaldados por la información disponible.
Las keywords son orientación semántica, no una condición para encontrar exactamente las mismas palabras.
Cada candidato contiene dos fuentes separadas: sources.cv para la hoja de vida y sources.registration para los datos declarados durante el registro.
Usa únicamente la evidencia entregada. No inventes experiencia, estudios ni habilidades.
Para experiencia, estudios, cargos, habilidades y certificaciones, usa la hoja de vida.
Del registro solo recibirás medio de transporte y residencia; no esperes que esos datos aparezcan en la hoja de vida.
No antepongas "Hoja de vida:" a las evidencias tomadas del documento; escríbelas directamente para evitar repeticiones.
Usa "Registro:" solo cuando la evidencia provenga del medio de transporte o la residencia registrados por el candidato.
Si las fuentes o los dos componentes del perfil se contradicen, muestra el punto como algo por confirmar y no elimines silenciosamente un requisito.
La ausencia de información debe aparecer como un faltante, no como una afirmación negativa.
STRONG significa que existe evidencia clara para la mayoría de criterios indispensables.
POSSIBLE significa que hay señales útiles, pero faltan datos o experiencia para confirmar.
LOW significa que la información sí fue revisada, pero contiene poca evidencia relacionada.
Devuelve exactamente un resultado por cada candidateId recibido, conserva el identificador sin modificarlo y no omitas candidatos aunque tengan poca evidencia.
No rechaces candidatos ni uses información personal. Devuelve razones breves y evidencia concreta.`,
    userContent: JSON.stringify({
      comparisonProfile,
      candidates
    })
  }, {
    ...options,
    prisma,
    usageStage: 'candidate_comparison',
    usageVacancyId: options.usageVacancyId,
    usageCandidateCount: candidates.length
  });

  if (completeMatchResponse(response, candidateIds)) {
    writeReviewCache(candidateComparisonCache, cacheKey, response);
  }
  return response;
}

function normalizeMatch(match = {}) {
  const score = Math.max(0, Math.min(100, Number(match.score || 0)));
  const level = ['STRONG', 'POSSIBLE', 'LOW'].includes(match.level)
    ? match.level
    : score >= 75 ? 'STRONG' : score >= 45 ? 'POSSIBLE' : 'LOW';
  return {
    candidateId: compact(match.candidateId),
    level,
    score,
    reasons: Array.isArray(match.reasons) ? match.reasons.map(compact).filter(Boolean).slice(0, 4) : [],
    evidence: Array.isArray(match.evidence)
      ? match.evidence.map((item) => compact(item).replace(/^Hoja de vida:\s*/i, '')).filter(Boolean).slice(0, 5)
      : [],
    gaps: Array.isArray(match.gaps) ? match.gaps.map(compact).filter(Boolean).slice(0, 4) : []
  };
}

function collectExpectedMatches(response, candidateIds = []) {
  const expectedIds = new Set(candidateIds.map(compact).filter(Boolean));
  const matches = new Map();
  const results = Array.isArray(response?.results) ? response.results : [];
  for (const result of results) {
    const normalized = normalizeMatch(result);
    if (!expectedIds.has(normalized.candidateId) || matches.has(normalized.candidateId)) continue;
    matches.set(normalized.candidateId, normalized);
  }
  return matches;
}

function addExpectedMatches(target, response, candidateIds = []) {
  for (const [candidateId, match] of collectExpectedMatches(response, candidateIds)) {
    if (!target.has(candidateId)) target.set(candidateId, match);
  }
}

function ensureMatchResults(response, candidateIds = []) {
  if (!completeMatchResponse(response, candidateIds)) {
    throw new Error('match_batch_invalid_results');
  }
  return response;
}

function reserveIndividualRetries(individualRetryBudget, requested) {
  const available = Math.max(0, Number(individualRetryBudget?.remaining || 0));
  const granted = Math.min(Math.max(0, Number(requested || 0)), available);
  if (individualRetryBudget) {
    individualRetryBudget.remaining = available - granted;
  }
  return granted;
}

async function compareCandidateBatchReliably(
  prisma,
  comparisonProfile,
  batch,
  individualRetryBudget,
  options = {}
) {
  const candidates = batch.map((item) => candidateForMatching(item.candidate, item.analysis));
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  const matches = new Map();
  let batchError = null;
  let batchSucceeded = false;

  for (let attempt = 0; attempt <= MATCH_BATCH_RETRY_LIMIT; attempt += 1) {
    if (attempt > 0 && candidates.length === 1) {
      const reserved = reserveIndividualRetries(individualRetryBudget, 1);
      if (!reserved) {
        batchError = 'individual_retry_budget_exhausted';
        break;
      }
    }
    try {
      const response = ensureMatchResults(
        await matchCandidateBatch(prisma, comparisonProfile, candidates, {
          ...options,
          usageVacancyId: batch[0]?.candidate?.vacancyId
        }),
        candidateIds
      );
      addExpectedMatches(matches, response, candidateIds);
      batchSucceeded = true;
      break;
    } catch (error) {
      batchError = safeErrorMessage(error);
    }
  }

  if (!batchSucceeded) {
    return {
      failed: true,
      failureType: 'batch',
      results: [],
      missingIds: candidateIds,
      error: batchError
    };
  }

  let missingCandidates = candidates.filter((candidate) => !matches.has(candidate.candidateId));
  let recoveryError = null;

  if (missingCandidates.length > 1) {
    try {
      const missingCandidateIds = missingCandidates.map((candidate) => candidate.candidateId);
      const response = ensureMatchResults(
        await matchCandidateBatch(prisma, comparisonProfile, missingCandidates, {
          ...options,
          usageVacancyId: batch[0]?.candidate?.vacancyId
        }),
        missingCandidateIds
      );
      addExpectedMatches(matches, response, missingCandidateIds);
    } catch (error) {
      recoveryError = safeErrorMessage(error);
    }
  }

  missingCandidates = candidates.filter((candidate) => !matches.has(candidate.candidateId));
  const individualRetryCount = reserveIndividualRetries(
    individualRetryBudget,
    missingCandidates.length
  );
  const individualCandidates = missingCandidates.slice(0, individualRetryCount);
  const individualMatches = await mapWithConcurrency(individualCandidates, 3, async (candidate) => {
    try {
      const response = ensureMatchResults(
        await matchCandidateBatch(prisma, comparisonProfile, [candidate], {
          ...options,
          usageVacancyId: batch[0]?.candidate?.vacancyId
        }),
        [candidate.candidateId]
      );
      return collectExpectedMatches(response, [candidate.candidateId]).get(candidate.candidateId) || null;
    } catch {
      return null;
    }
  });

  for (const match of individualMatches) {
    if (match && !matches.has(match.candidateId)) matches.set(match.candidateId, match);
  }

  const missingIds = candidateIds.filter((candidateId) => !matches.has(candidateId));
  return {
    failed: missingIds.length > 0,
    failureType: missingIds.length ? 'partial' : null,
    results: [...matches.values()],
    missingIds,
    error: recoveryError
  };
}

export function groupCandidateReviewResults(results = []) {
  const groups = { strong: [], possible: [], low: [], manual: [] };
  for (const result of results) {
    if (result.manualReason || !result.match) groups.manual.push(result);
    else if (result.match.level === 'STRONG') groups.strong.push(result);
    else if (result.match.level === 'POSSIBLE') groups.possible.push(result);
    else groups.low.push(result);
  }
  for (const key of ['strong', 'possible', 'low']) {
    groups[key].sort((left, right) => right.match.score - left.match.score);
  }
  return groups;
}

export async function reviewVacancyCandidates(prisma, { vacancyId, desiredProfile } = {}, options = {}) {
  const modelUsed = selectedModel(options);
  const cleanVacancyId = compact(vacancyId);
  const cleanProfile = compact(desiredProfile).slice(0, 4000);
  if (!cleanVacancyId) return { ok: false, reason: 'vacancy_required' };
  if (cleanProfile.length < 12) return { ok: false, reason: 'profile_too_short' };
  if (!isOpenAiAvailable(options)) return { ok: false, reason: 'ai_not_configured' };

  const vacancy = await prisma.vacancy.findUnique({
    where: { id: cleanVacancyId },
    select: {
      id: true,
      title: true,
      city: true,
      requirements: true,
      roleDescription: true
    }
  });
  if (!vacancy) return { ok: false, reason: 'vacancy_not_found' };

  const loadedCandidates = await prisma.candidate.findMany({
    where: {
      vacancyId: cleanVacancyId,
      status: { in: ELIGIBLE_CANDIDATE_STATUSES },
      OR: [
        { cvStorageKey: { not: null } },
        { cvData: { not: null } },
        { cvOriginalName: { not: null } }
      ]
    },
    orderBy: { updatedAt: 'desc' },
    take: MAX_CANDIDATES_PER_REVIEW + 1,
    include: {
      vacancy: { select: { id: true, title: true, city: true } },
      attachmentAnalyses: { orderBy: { analysedAt: 'desc' }, take: 1 }
    }
  });

  const truncated = loadedCandidates.length > MAX_CANDIDATES_PER_REVIEW;
  const candidates = loadedCandidates.slice(0, MAX_CANDIDATES_PER_REVIEW);
  if (!candidates.length) {
    return {
      ok: true,
      vacancy,
      desiredProfile: cleanProfile,
      interpretedProfile: null,
      modelUsed,
      results: [],
      groups: groupCandidateReviewResults([]),
      stats: { total: 0, readable: 0, strong: 0, possible: 0, low: 0, manual: 0 },
      truncated: false
    };
  }

  let interpretedProfile;
  try {
    interpretedProfile = await interpretDesiredProfile(prisma, vacancy, cleanProfile, options);
  } catch (error) {
    return { ok: false, reason: 'profile_analysis_failed', error: safeErrorMessage(error), vacancy };
  }
  if (!interpretedProfile) return { ok: false, reason: 'profile_analysis_failed', vacancy };

  const analyzed = await mapWithConcurrency(candidates, 3, async (candidate) => {
    const cached = latestUsableAnalysis(candidate);
    if (cached) return { candidate, analysis: cached, cached: true };

    try {
      const generated = await analyzeCandidateCv(prisma, candidate.id, options);
      return {
        candidate,
        analysis: generated.analysis || null,
        evidence: generated.evidence || null,
        failureReason: generated.ok ? null : generated.reason,
        cached: false
      };
    } catch (error) {
      return {
        candidate,
        analysis: null,
        failureReason: 'ai_analysis_failed',
        error: safeErrorMessage(error),
        cached: false
      };
    }
  });

  const readable = analyzed.filter((item) => {
    if (item.analysis?.classification !== AttachmentClassification.CV_VALID) return false;
    return Boolean(parseCvAnalysisEvidence(item.analysis)?.extracted);
  });
  const manual = analyzed
    .filter((item) => !readable.includes(item))
    .map((item) => ({
      candidate: item.candidate,
      analysis: item.analysis,
      match: null,
      manualReason: item.analysis?.summary || failureSummary(item.failureReason)
    }));

  const comparisonProfile = buildComparisonProfile(vacancy, cleanProfile, interpretedProfile);
  const comparisonEntries = readable.map((item) => {
    const candidatePayload = candidateForMatching(item.candidate, item.analysis);
    const analysisEvidence = parseCvAnalysisEvidence(item.analysis);
    const analysisVersion = {
      id: item.analysis?.id || null,
      analysedAt: item.analysis?.analysedAt || null,
      documentReference: analysisEvidence?.documentReference
        || candidateCvReference(item.candidate)
    };
    return {
      item,
      candidatePayload,
      modelUsed,
      fingerprint: reviewCacheKey('candidate-match', {
        model: modelUsed,
        vacancyId: item.candidate.vacancyId || vacancy.id || null,
        comparisonProfile,
        analysisVersion,
        candidate: candidatePayload
      })
    };
  });
  const storedMatches = await readStoredComparisons(prisma, comparisonEntries);
  const pendingReadable = comparisonEntries
    .filter((entry) => !storedMatches.has(entry.item.candidate.id))
    .map((entry) => entry.item);

  const batches = [];
  for (let index = 0; index < pendingReadable.length; index += MATCH_BATCH_SIZE) {
    batches.push(pendingReadable.slice(index, index + MATCH_BATCH_SIZE));
  }
  const individualRetryBudget = { remaining: MAX_INDIVIDUAL_MATCH_RETRIES };
  const responses = await mapWithConcurrency(
    batches,
    2,
    (batch) => compareCandidateBatchReliably(
      prisma,
      comparisonProfile,
      batch,
      individualRetryBudget,
      options
    )
  );
  const newMatches = responses.flatMap((response) => response.results);
  const successfulCandidateIds = new Set(
    responses
      .filter((response) => !response.failed)
      .flatMap((response) => response.results.map((match) => match.candidateId))
  );
  const matchesToPersist = newMatches.filter((match) => successfulCandidateIds.has(match.candidateId));
  await writeStoredComparisons(prisma, comparisonEntries, matchesToPersist);
  const matches = [...storedMatches.values(), ...newMatches];
  const hasBatchFailure = responses.some((response) => response.failureType === 'batch');
  const hasPartialFailure = responses.some((response) => response.failureType === 'partial');
  const comparisonWarning = hasBatchFailure
    ? 'No fue posible ejecutar algunos lotes de comparación después de un único reintento controlado. Los perfiles permanecen visibles para revisión manual sin generar llamadas individuales masivas.'
    : hasPartialFailure
      ? 'Algunas respuestas válidas omitieron perfiles incluso después de reintentos acotados. Esos perfiles permanecen visibles para revisión manual.'
      : null;

  const manualReasonsByCandidate = new Map();
  for (const response of responses) {
    const reason = response.failureType === 'batch'
      ? 'No fue posible ejecutar la comparación automática del lote después de un reintento controlado. Revisa este perfil manualmente.'
      : 'La respuesta de comparación siguió incompleta después de reintentos acotados. Revisa este perfil manualmente.';
    for (const candidateId of response.missingIds || []) {
      manualReasonsByCandidate.set(candidateId, reason);
    }
  }

  const matchesByCandidate = new Map(matches.map((match) => [match.candidateId, match]));
  const reviewed = readable.map((item) => {
    const match = matchesByCandidate.get(item.candidate.id) || null;
    return {
      candidate: item.candidate,
      analysis: item.analysis,
      match,
      manualReason: match
        ? null
        : manualReasonsByCandidate.get(item.candidate.id)
          || 'No fue posible completar la comparación automática. Revisa este perfil manualmente.'
    };
  });
  const results = [...reviewed, ...manual];
  const groups = groupCandidateReviewResults(results);

  return {
    ok: true,
    vacancy,
    desiredProfile: cleanProfile,
    interpretedProfile,
    modelUsed,
    warnings: comparisonWarning ? [comparisonWarning] : [],
    results,
    groups,
    stats: {
      total: candidates.length,
      readable: readable.length,
      strong: groups.strong.length,
      possible: groups.possible.length,
      low: groups.low.length,
      manual: groups.manual.length
    },
    truncated
  };
}

export { MODEL as CV_ANALYSIS_MODEL };
