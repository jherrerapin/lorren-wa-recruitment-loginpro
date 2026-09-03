import {
  alignCandidateLocationFields,
  isHighConfidenceLocalField,
  normalizeCandidateFields,
  normalizeTransportMode,
  parseNaturalData,
  shouldPreserveStructuredLocalField
} from './candidateData.js';
import { detectRoleHintFromText } from './vacancyResolver.js';
import { sanitizeCandidateFieldsForConversation } from './fieldSanitizer.js';

const EMPTY_USAGE = Object.freeze({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
const EVIDENCE_SENSITIVE_FIELDS = new Set(['fullName', 'documentNumber', 'neighborhood', 'locality', 'transportMode']);

const EMPTY_UNDERSTANDING = Object.freeze({
  intent: 'unknown',
  vacancyDetection: { detected: false, value: null, confidence: 0 },
  cityDetection: { detected: false, value: null, confidence: 0 },
  candidateFields: {},
  corrections: [],
  contradictions: [],
  missingFields: [],
  rejectedFields: [],
  suggestedNextAction: 'ask_for_clarification',
  fieldConfidence: {},
  replyGuidance: { tone: 'neutral', goal: 'collect_data' }
});

function baseUnderstanding() {
  return {
    intent: EMPTY_UNDERSTANDING.intent,
    vacancyDetection: { ...EMPTY_UNDERSTANDING.vacancyDetection },
    cityDetection: { ...EMPTY_UNDERSTANDING.cityDetection },
    candidateFields: {},
    corrections: [],
    contradictions: [],
    missingFields: [],
    rejectedFields: [],
    suggestedNextAction: EMPTY_UNDERSTANDING.suggestedNextAction,
    fieldConfidence: {},
    replyGuidance: { ...EMPTY_UNDERSTANDING.replyGuidance }
  };
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function compactFields(fields = {}) {
  return Object.fromEntries(
    Object.entries(fields || {}).filter(([, value]) => hasValue(value))
  );
}

function normalizeAiFields(aiFields = {}) {
  const normalized = normalizeCandidateFields(compactFields(aiFields));
  return compactFields(normalized);
}

function buildConfidenceFromEvidence(fields = {}, evidence = {}) {
  const confidence = {};
  for (const field of Object.keys(fields || {})) {
    const fieldEvidence = evidence?.[field];
    confidence[field] = Number.isFinite(Number(fieldEvidence?.confidence))
      ? Number(fieldEvidence.confidence)
      : 0.85;
  }
  return confidence;
}

function buildLocalEvidence(fields = {}, text = '') {
  const snippet = String(text || '').slice(0, 180);
  return Object.fromEntries(
    Object.keys(fields || {}).map((field) => [
      field,
      { snippet, confidence: 0.74, source: 'local_parser' }
    ])
  );
}

function buildEngineEvidence(fields = {}, text = '') {
  const snippet = String(text || '').slice(0, 180);
  return Object.fromEntries(
    Object.keys(fields || {}).map((field) => [
      field,
      { snippet, confidence: 0.8, source: 'engine' }
    ])
  );
}

function mergeFieldSource(sourceByField, field, source) {
  if (!field || !source) return;
  sourceByField[field] = sourceByField[field] ? 'merged' : source;
}

function sumTokenUsage(current = {}, next = {}) {
  return {
    input_tokens: Number(current.input_tokens || 0) + Number(next.input_tokens || 0),
    output_tokens: Number(current.output_tokens || 0) + Number(next.output_tokens || 0),
    total_tokens: Number(current.total_tokens || 0) + Number(next.total_tokens || 0)
  };
}

function hasFieldsFromOriginalUnderstanding(turnInterpretation = {}) {
  return Object.entries(turnInterpretation.sourceByField || {}).some(([field, source]) => (
    source !== 'engine' && hasValue(turnInterpretation.fields?.[field])
  ));
}

function normalizeEntityComparable(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function evidenceSupportsValue(field, value, evidence = {}) {
  const snippet = String(evidence?.snippet || '').trim();
  if (!snippet) return false;

  if (field === 'documentNumber') {
    const expected = normalizeDigits(value);
    const observed = normalizeDigits(snippet);
    return Boolean(expected && observed && observed.includes(expected));
  }

  if (field === 'transportMode') {
    const expected = normalizeTransportMode(value);
    const observed = normalizeTransportMode(snippet);
    return Boolean(expected && observed && expected === observed);
  }

  const expected = normalizeEntityComparable(value);
  const observed = normalizeEntityComparable(snippet);
  return Boolean(expected && observed && observed.includes(expected));
}

function shouldPreserveAcceptedLocalField(field, localValue, proposedValue, evidence = {}) {
  if (!hasValue(localValue) || !hasValue(proposedValue)) return false;
  if (normalizeEntityComparable(localValue) === normalizeEntityComparable(proposedValue)) return false;
  if (shouldPreserveStructuredLocalField(field, localValue, proposedValue)) return true;
  if (!EVIDENCE_SENSITIVE_FIELDS.has(field)) return false;

  // Para identidad, residencia, documento y transporte una fuente posterior
  // solo desplaza un valor ya aceptado cuando trae evidencia específica que
  // respalda su propio valor. La ausencia o contradicción de evidencia no
  // puede borrar una entidad ya comprendida del mismo turno.
  return !evidenceSupportsValue(field, proposedValue, evidence);
}

function conflictsWithIndependentIdentityEvidence(field, value, localFields = {}) {
  const comparable = normalizeEntityComparable(value);
  if (!comparable) return false;

  if (field === 'fullName') {
    return ['neighborhood', 'locality'].some((residenceField) => (
      hasValue(localFields[residenceField])
      && normalizeEntityComparable(localFields[residenceField]) === comparable
    ));
  }

  if (field === 'neighborhood' || field === 'locality') {
    return hasValue(localFields.fullName)
      && normalizeEntityComparable(localFields.fullName) === comparable;
  }

  return false;
}

function normalizeContextualConfirmationText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function semanticGateAcceptsExperienceConfirmation(context = {}) {
  const lastBotQuestion = String(
    context.lastBotQuestion
    || context.conversationContext?.lastBotQuestion
    || ''
  ).trim();
  if (!lastBotQuestion) return false;

  const probe = sanitizeCandidateFieldsForConversation({
    fields: { experienceInfo: 'Sí' },
    evidence: {
      experienceInfo: {
        snippet: 'sí',
        confidence: 1,
        source: 'context_probe'
      }
    },
    text: 'sí',
    context,
    turnType: 'CONFIRMATION'
  });

  return probe.fields.experienceInfo === 'Sí';
}

function buildContextualExperienceSummaryCandidate(input = '', context = {}) {
  const segments = String(input || '')
    .split(/\n+/)
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!segments.length) return { fields: {}, evidence: {} };

  const acceptedSegments = [];
  for (const segment of segments) {
    const segmentEvidence = {
      experienceSummary: {
        snippet: segment.slice(0, 120),
        confidence: 0.95,
        source: 'contextual_answer'
      }
    };
    const probe = sanitizeCandidateFieldsForConversation({
      fields: { experienceSummary: segment },
      evidence: segmentEvidence,
      text: segment,
      context,
      turnType: null
    });
    if (hasValue(probe.fields.experienceSummary)) {
      acceptedSegments.push(probe.fields.experienceSummary);
    }
  }

  let uniqueSegments = [...new Set(acceptedSegments)];
  if (!uniqueSegments.length) {
    const contextualTail = segments.at(-1) || '';
    const tailParsed = normalizeCandidateFields(parseNaturalData(contextualTail));
    const tailHasOtherCandidateData = Object.entries(tailParsed).some(([field, value]) => (
      hasValue(value)
      && !['experienceInfo', 'experienceTime', 'experienceSummary'].includes(field)
    ));
    const tailLooksLikeName = isHighConfidenceLocalField('fullName', contextualTail);
    const tailLooksTechnical = /^\s*\[[A-Z0-9_:-]+\]\s*$/.test(contextualTail);
    const tailLooksLikeQuestion = /[¿?]/.test(contextualTail);

    if (
      contextualTail
      && !tailHasOtherCandidateData
      && !tailLooksLikeName
      && !tailLooksTechnical
      && !tailLooksLikeQuestion
    ) {
      uniqueSegments = [contextualTail];
    }
  }
  if (!uniqueSegments.length) return { fields: {}, evidence: {} };

  const experienceSummary = uniqueSegments.join('; ');
  return {
    fields: { experienceSummary },
    evidence: {
      experienceSummary: {
        snippet: experienceSummary.slice(0, 120),
        confidence: 0.95,
        source: 'contextual_answer'
      }
    }
  };
}

function buildContextualExperienceCandidate(input = '', context = {}) {
  if (!semanticGateAcceptsExperienceConfirmation(context)) return { fields: {}, evidence: {} };

  const normalized = normalizeContextualConfirmationText(input);
  if (!normalized) return { fields: {}, evidence: {} };

  const snippet = String(input || '').slice(0, 120);
  if (/^(?:no|nop|negativo)$/.test(normalized)) {
    return {
      fields: { experienceInfo: 'No' },
      evidence: {
        experienceInfo: { snippet, confidence: 0.95, source: 'contextual_confirmation' }
      }
    };
  }

  const affirmative = normalized.match(/^(?:si|sii|sip)(?:\s+(\d+)\s+(personas?|anos?|meses?|semanas?))?$/);
  if (!affirmative) return buildContextualExperienceSummaryCandidate(input, context);

  const fields = { experienceInfo: 'Sí' };
  const evidence = {
    experienceInfo: { snippet, confidence: 0.95, source: 'contextual_confirmation' }
  };
  const amount = Number.parseInt(affirmative[1] || '', 10);
  const unit = affirmative[2] || '';

  if (Number.isInteger(amount) && amount > 0 && /^(?:anos?|meses?|semanas?)$/.test(unit)) {
    if (/^anos?$/.test(unit)) fields.experienceTime = `${amount} ${amount === 1 ? 'año' : 'años'}`;
    if (/^meses?$/.test(unit)) fields.experienceTime = `${amount} ${amount === 1 ? 'mes' : 'meses'}`;
    if (/^semanas?$/.test(unit)) fields.experienceTime = `${amount} ${amount === 1 ? 'semana' : 'semanas'}`;
    evidence.experienceTime = { snippet, confidence: 0.95, source: 'contextual_confirmation' };
  }

  return { fields, evidence };
}

function buildRuntimeTurnInterpretation(input, aiResult, runtime = {}, context = {}) {
  const localParsedData = runtime.localParsedData || parseNaturalData(input);
  const rawAiFields = aiResult?.parsedFields || {};
  const aiFields = normalizeAiFields(rawAiFields);
  const extractionEvidence = aiResult?.extraction?.fieldEvidence || {};
  const engineFields = runtime.engineFields && typeof runtime.engineFields === 'object'
    ? normalizeAiFields(runtime.engineFields)
    : {};
  const contextualExperience = buildContextualExperienceCandidate(input, context);
  const turnType = aiResult?.extraction?.turnType || null;

  const localCandidates = compactFields(normalizeCandidateFields(Object.fromEntries(
    Object.entries(localParsedData).filter(([field, value]) => (
      hasValue(value) && isHighConfidenceLocalField(field, value)
    ))
  )));
  const localEvidence = buildLocalEvidence(localCandidates, input);
  const localGate = sanitizeCandidateFieldsForConversation({
    fields: localCandidates,
    evidence: localEvidence,
    text: input,
    context,
    turnType: null
  });
  const aiGate = sanitizeCandidateFieldsForConversation({
    fields: aiFields,
    evidence: extractionEvidence,
    text: input,
    context,
    turnType
  });
  const engineEvidence = buildEngineEvidence(engineFields, input);
  const engineGate = sanitizeCandidateFieldsForConversation({
    fields: engineFields,
    evidence: engineEvidence,
    text: input,
    context,
    turnType
  });

  const sourceByField = {};
  const evidenceByField = {};
  const mergedData = {};

  // Cada fuente se valida antes de competir por un campo. Así una propuesta
  // posterior rechazada no borra el fallback ya aceptado. La IA conserva la
  // precedencia semántica cuando su propuesta está respaldada; el parser local
  // actúa como evidencia independiente/fallback y no como segunda autoridad.
  for (const [field, value] of Object.entries(localGate.fields)) {
    mergedData[field] = value;
    mergeFieldSource(sourceByField, field, 'local');
    evidenceByField[field] = localGate.evidence[field];
  }

  for (const [field, value] of Object.entries(aiGate.fields)) {
    if (shouldPreserveAcceptedLocalField(field, localGate.fields[field], value, aiGate.evidence[field])) continue;
    if (conflictsWithIndependentIdentityEvidence(field, value, localGate.fields)) continue;
    mergedData[field] = value;
    mergeFieldSource(sourceByField, field, 'openai');
    if (aiGate.evidence[field]) evidenceByField[field] = aiGate.evidence[field];
  }

  for (const [field, value] of Object.entries(engineGate.fields)) {
    if (shouldPreserveAcceptedLocalField(field, localGate.fields[field], value, engineGate.evidence[field])) continue;
    if (conflictsWithIndependentIdentityEvidence(field, value, localGate.fields)) continue;
    mergedData[field] = value;
    mergeFieldSource(sourceByField, field, 'engine');
    if (engineGate.evidence[field]) evidenceByField[field] = engineGate.evidence[field];
  }

  for (const [field, value] of Object.entries(contextualExperience.fields)) {
    if (hasValue(mergedData[field]) || !hasValue(value)) continue;
    mergedData[field] = value;
    mergeFieldSource(sourceByField, field, 'contextual');
    evidenceByField[field] = contextualExperience.evidence[field];
  }

  let fields = normalizeCandidateFields(mergedData);
  if (runtime.vacancy) {
    fields = alignCandidateLocationFields(fields, runtime.vacancy, { clearAlternate: false });
  }
  if (typeof runtime.enrichFields === 'function') {
    fields = runtime.enrichFields(fields) || fields;
  }

  const semanticGate = sanitizeCandidateFieldsForConversation({
    fields,
    evidence: evidenceByField,
    text: input,
    context,
    turnType
  });
  fields = semanticGate.fields;

  for (const rejected of semanticGate.rejectedFields) {
    delete sourceByField[rejected.field];
    delete evidenceByField[rejected.field];
  }

  return {
    intent: 'unknown',
    fields,
    sourceByField,
    evidenceByField,
    rejectedFields: semanticGate.rejectedFields,
    cityHint: null,
    roleHint: null,
    detectedFields: [...new Set([
      ...Object.keys(rawAiFields).filter((field) => fields[field] !== undefined),
      ...Object.keys(engineFields).filter((field) => fields[field] !== undefined)
    ])],
    engineFieldCount: Object.keys(engineFields).length,
    usage: sumTokenUsage(aiResult?.usage || EMPTY_USAGE, runtime.engineUsage || EMPTY_USAGE)
  };
}

function detectCorrectionIntent(text = '', aiResult = {}) {
  const extraction = aiResult?.extraction || {};
  if (Array.isArray(extraction.conflicts) && extraction.conflicts.length) return true;
  return ['provide_correction', 'confirm_correction'].includes(String(aiResult?.intent || '').toLowerCase());
}

function findTransportContradiction(candidateFields = {}) {
  if (candidateFields.transportMode !== 'Publico') return null;
  return {
    field: 'transportMode',
    current: candidateFields.transportMode,
    details: 'Negación explícita de transporte detectada'
  };
}

export async function conversationUnderstanding(text, options = {}) {
  const input = String(text || '');
  const understanding = baseUnderstanding();
  const aiResult = options.aiResult || null;
  const aiFields = aiResult?.parsedFields || {};
  const rawAiCandidateFields = compactFields(aiFields);
  const aiCandidateFields = normalizeAiFields(aiFields);
  const aiEvidence = aiResult?.extraction?.fieldEvidence || {};
  const aiCity = typeof aiFields.city === 'string' ? aiFields.city.trim() || null : null;
  const aiRoleHint = typeof aiFields.roleHint === 'string' ? aiFields.roleHint.trim() || null : null;
  const extractionWasUseful = aiResult?.status === 'ok' && (Object.keys(aiCandidateFields).length > 0 || aiCity || aiRoleHint || aiResult.intent);
  const runtime = options.runtime && typeof options.runtime === 'object' ? options.runtime : null;

  if (runtime) {
    const turnInterpretation = buildRuntimeTurnInterpretation(input, aiResult, runtime, options.context || {});
    understanding.turnInterpretation = turnInterpretation;
    understanding.candidateFields = turnInterpretation.fields;
    understanding.rejectedFields = turnInterpretation.rejectedFields;
    understanding.intent = hasFieldsFromOriginalUnderstanding(turnInterpretation)
      ? 'provide_data'
      : (aiResult?.intent || 'unknown');
    understanding.suggestedNextAction = Object.keys(turnInterpretation.fields).length ? 'collect_or_confirm' : 'ask_for_clarification';
    understanding.fieldConfidence = buildConfidenceFromEvidence(turnInterpretation.fields, turnInterpretation.evidenceByField);
  } else if (extractionWasUseful) {
    const sanitized = sanitizeCandidateFieldsForConversation({
      fields: rawAiCandidateFields,
      evidence: aiEvidence,
      text: input,
      context: options.context || {},
      turnType: aiResult?.extraction?.turnType || null
    });
    understanding.candidateFields = normalizeAiFields(sanitized.fields);
    understanding.rejectedFields = sanitized.rejectedFields;
    understanding.intent = Object.keys(understanding.candidateFields).length ? 'provide_data' : (aiResult.intent || 'unknown');
    understanding.suggestedNextAction = Object.keys(understanding.candidateFields).length ? 'collect_or_confirm' : 'ask_for_clarification';
    understanding.fieldConfidence = buildConfidenceFromEvidence(understanding.candidateFields, sanitized.evidence);
  } else {
    const localParsed = parseNaturalData(input);
    const normalized = normalizeCandidateFields(localParsed);
    const localCandidateFields = compactFields(normalized);
    const localEvidence = buildLocalEvidence(localCandidateFields, input);
    const sanitized = sanitizeCandidateFieldsForConversation({
      fields: localCandidateFields,
      evidence: localEvidence,
      text: input,
      context: options.context || {},
      turnType: null
    });
    understanding.candidateFields = sanitized.fields;
    understanding.rejectedFields = sanitized.rejectedFields;
    understanding.intent = Object.keys(understanding.candidateFields).length ? 'provide_data' : 'unknown';
    understanding.suggestedNextAction = Object.keys(understanding.candidateFields).length ? 'collect_or_confirm' : 'ask_for_clarification';
    for (const field of Object.keys(understanding.candidateFields)) {
      understanding.fieldConfidence[field] = Number(sanitized.evidence?.[field]?.confidence) || 0.7;
    }
  }

  if (aiCity) {
    understanding.cityDetection = { detected: true, value: aiCity, confidence: 0.85 };
  }

  const localRoleHint = extractionWasUseful ? null : detectRoleHintFromText(input);
  if (aiRoleHint || localRoleHint) {
    const value = aiRoleHint || localRoleHint;
    understanding.vacancyDetection = {
      detected: true,
      value,
      confidence: aiRoleHint ? 0.85 : 0.6
    };
  }

  if (detectCorrectionIntent(input, aiResult)) {
    understanding.intent = 'provide_correction';
    understanding.corrections.push({ source: aiResult?.status === 'ok' ? 'ai_extraction' : 'text', reason: 'correction_or_conflict_detected' });
  }

  const contradiction = findTransportContradiction(understanding.candidateFields);
  if (contradiction) understanding.contradictions.push(contradiction);

  if (typeof options.aiParser === 'function') {
    const secondaryAiResult = await options.aiParser(input, options.context || {});
    if (secondaryAiResult?.intent) understanding.intent = secondaryAiResult.intent;
  }

  if (understanding.turnInterpretation) {
    understanding.turnInterpretation.intent = aiResult?.intent || understanding.intent || runtime?.fallbackIntent || 'unknown';
    understanding.turnInterpretation.cityHint = aiFields.city || understanding.cityDetection?.value || null;
    understanding.turnInterpretation.roleHint = aiFields.roleHint || understanding.vacancyDetection?.value || null;
  }

  return understanding;
}
