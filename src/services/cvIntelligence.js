import axios from 'axios';
import crypto from 'node:crypto';
import { CV_EXTRACTION_SCHEMA } from '../ai/cvExtractionSchema.js';
import { resolveCandidateCvBuffer } from './cvStorage.js';
import { extractCvText } from './cvTextExtraction.js';
import { OPENAI_CV_MODEL } from './openAiModelConfig.js';
import { normalizeTransportMode } from './transportMode.js';

const AttachmentClassification = Object.freeze({
  CV_VALID: 'CV_VALID',
  OTHER: 'OTHER',
  UNREADABLE: 'UNREADABLE'
});
const URL = 'https://api.openai.com/v1/responses';
const MODEL = OPENAI_CV_MODEL;
const MAX_CANDIDATES_PER_REVIEW = 120;
const MATCH_BATCH_SIZE = 30;
const VISUAL_CONFIDENCE_THRESHOLD = 0.5;
const MIN_USEFUL_PDF_TEXT_LENGTH = 80;

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
            reasons: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
            gaps: { type: 'array', items: { type: 'string' } }
          },
          required: ['candidateId', 'level', 'score', 'reasons', 'evidence', 'gaps']
        }
      }
    },
    required: ['results']
  }
};

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

export function safeErrorMessage(error) {
  const message = error?.message || String(error || 'unknown_error');
  const stack = error?.stack ? `\nStack: ${error.stack}` : '';
  return `${message}${stack}`
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access_token=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 1000);
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
  const payload = {
    model: selectedModel(options),
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

  return parseOutput(response?.data || response);
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
    extracted = visualFallback
      ? await extractCvWithAi({
        buffer,
        mimeType: candidate.cvMimeType,
        fileName: candidate.cvOriginalName
      }, options)
      : await extractCvWithAi({ text: textResult.text }, options);
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
  const registeredTransport = normalizeTransportMode(candidate.transportMode) || compact(candidate.transportMode) || null;
  const registeredResidence = compact(candidate.locality)
    || compact(candidate.neighborhood)
    || compact(candidate.zone)
    || null;
  return {
    candidateId: candidate.id,
    sources: {
      cv: {
        confidence: Number(analysis.confidence || 0),
        city: extracted.city || null,
        locality: extracted.locality || null,
        experienceSummary: extracted.experienceSummary || null,
        lastRole: extracted.lastRole || null,
        educationSummary: extracted.educationSummary || null,
        estimatedExperienceMonths: extracted.estimatedExperienceMonths ?? null,
        skills: Array.isArray(extracted.skills) ? extracted.skills : [],
        certifications: Array.isArray(extracted.certifications) ? extracted.certifications : [],
        experience: Array.isArray(extracted.experience) ? extracted.experience : []
      },
      registration: {
        transportMode: registeredTransport,
        residence: registeredResidence
      }
    }
  };
}

async function interpretDesiredProfile(vacancy, desiredProfile, options = {}) {
  return requestStructuredOutput({
    schema: DESIRED_PROFILE_SCHEMA,
    systemText: `Convierte la descripción sencilla de un coordinador en criterios claros para revisar perfiles de candidatos.
Puedes usar requisitos que estén escritos explícitamente en la vacante o en la solicitud del coordinador.
No agregues requisitos que no aparezcan en ninguna de esas dos fuentes.
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
      coordinatorRequest: desiredProfile
    })
  }, options);
}

async function matchCandidateBatch(interpretedProfile, candidates, options = {}) {
  return requestStructuredOutput({
    schema: CANDIDATE_MATCH_SCHEMA,
    systemText: `Compara la información disponible de cada candidato con un perfil buscado para apoyar a un coordinador humano.
Cada candidato contiene dos fuentes separadas: sources.cv para la hoja de vida y sources.registration para los datos declarados durante el registro.
Usa únicamente la evidencia entregada. No inventes experiencia, estudios ni habilidades.
Para experiencia, estudios, cargos, habilidades y certificaciones, usa la hoja de vida.
Del registro solo recibirás medio de transporte y residencia; no esperes que esos datos aparezcan en la hoja de vida.
Cuando cites evidencia, inicia cada frase con "Hoja de vida:" o "Registro:" para que el coordinador conozca la fuente.
Si las fuentes se contradicen, muestra el punto como algo por confirmar y no elijas silenciosamente una versión.
La ausencia de información debe aparecer como un faltante, no como una afirmación negativa.
STRONG significa que existe evidencia clara para la mayoría de criterios indispensables.
POSSIBLE significa que hay señales útiles, pero faltan datos o experiencia para confirmar.
LOW significa que la información sí fue revisada, pero contiene poca evidencia relacionada.
No rechaces candidatos ni uses información personal. Devuelve razones breves y evidencia concreta.`,
    userContent: JSON.stringify({
      interpretedProfile,
      candidates
    })
  }, options);
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
    reasons: Array.isArray(match.reasons) ? match.reasons.map(compact).filter(Boolean).slice(0, 5) : [],
    evidence: Array.isArray(match.evidence) ? match.evidence.map(compact).filter(Boolean).slice(0, 6) : [],
    gaps: Array.isArray(match.gaps) ? match.gaps.map(compact).filter(Boolean).slice(0, 6) : []
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
    interpretedProfile = await interpretDesiredProfile(vacancy, cleanProfile, options);
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

  const batches = [];
  for (let index = 0; index < readable.length; index += MATCH_BATCH_SIZE) {
    batches.push(readable.slice(index, index + MATCH_BATCH_SIZE));
  }
  const responses = await mapWithConcurrency(batches, 2, async (batch) => {
    try {
      const response = await matchCandidateBatch(
        interpretedProfile,
        batch.map((item) => candidateForMatching(item.candidate, item.analysis)),
        options
      );
      return {
        failed: !Array.isArray(response?.results),
        results: Array.isArray(response?.results) ? response.results : []
      };
    } catch (error) {
      return { failed: true, results: [], error: safeErrorMessage(error) };
    }
  });
  const matches = responses
    .flatMap((response) => response.results)
    .map(normalizeMatch)
    .filter((item) => item.candidateId);
  const comparisonWarning = responses.some((response) => response.failed)
    ? 'Algunas hojas de vida se pudieron leer, pero no comparar. Quedaron en revisión manual para no ocultarlas.'
    : null;

  const matchesByCandidate = new Map(matches.map((match) => [match.candidateId, match]));
  const reviewed = readable.map((item) => {
    const match = matchesByCandidate.get(item.candidate.id) || null;
    return {
      candidate: item.candidate,
      analysis: item.analysis,
      match,
      manualReason: match ? null : 'La hoja de vida se leyó, pero no fue posible compararla con el perfil.'
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
