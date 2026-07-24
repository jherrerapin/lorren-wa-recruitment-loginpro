import {
  alignCandidateLocationFields,
  isHighConfidenceLocalField,
  normalizeCandidateFields,
  parseNaturalData,
  shouldPreserveStructuredLocalField
} from './candidateData.js';
import { detectRoleHintFromText } from './vacancyResolver.js';
import { sanitizeCandidateFieldsForConversation } from './fieldSanitizer.js';

const EMPTY_USAGE = Object.freeze({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });

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

function buildRuntimeTurnInterpretation(input, aiResult, runtime = {}, context = {}) {
  const localParsedData = runtime.localParsedData || parseNaturalData(input);
  const aiFields = aiResult?.parsedFields || {};
  const extractionEvidence = aiResult?.extraction?.fieldEvidence || {};
  const engineFields = runtime.engineFields && typeof runtime.engineFields === 'object'
    ? normalizeAiFields(runtime.engineFields)
    : {};
  const sourceByField = {};
  const evidenceByField = {};
  const mergedData = {};

  for (const [field, value] of Object.entries(localParsedData)) {
    if (!hasValue(value) || !isHighConfidenceLocalField(field, value)) continue;
    mergedData[field] = value;
    mergeFieldSource(sourceByField, field, 'local');
    evidenceByField[field] = { snippet: input.slice(0, 120), confidence: 0.9, source: 'local' };
  }

  for (const [field, value] of Object.entries(aiFields)) {
    if (!hasValue(value) || shouldPreserveStructuredLocalField(field, localParsedData[field], value)) continue;
    mergedData[field] = value;
    mergeFieldSource(sourceByField, field, 'openai');
    if (extractionEvidence[field]) evidenceByField[field] = extractionEvidence[field];
  }

  for (const [field, value] of Object.entries(engineFields)) {
    if (!hasValue(value) || shouldPreserveStructuredLocalField(field, localParsedData[field], value)) continue;
    mergedData[field] = value;
    mergeFieldSource(sourceByField, field, 'engine');
    evidenceByField[field] = evidenceByField[field]
      || { snippet: input.slice(0, 120), confidence: 0.8, source: 'engine' };
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
    turnType: aiResult?.extraction?.turnType || null
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
      ...Object.keys(aiFields).filter((field) => fields[field] !== undefined),
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
