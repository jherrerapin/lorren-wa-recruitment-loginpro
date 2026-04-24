import { normalizeCandidateFields, parseNaturalData } from './candidateData.js';
import { detectRoleHintFromText } from './vacancyResolver.js';

const EMPTY_UNDERSTANDING = Object.freeze({
  intent: 'unknown',
  vacancyDetection: { detected: false, value: null, confidence: 0 },
  cityDetection: { detected: false, value: null, confidence: 0 },
  candidateFields: {},
  corrections: [],
  contradictions: [],
  missingFields: [],
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

function detectCorrectionIntent(text = '', aiResult = {}) {
  const extraction = aiResult?.extraction || {};
  if (Array.isArray(extraction.conflicts) && extraction.conflicts.length) return true;
  return ['provide_correction', 'confirm_correction'].includes(String(aiResult?.intent || '').toLowerCase());
}

function findTransportContradiction(candidateFields = {}) {
  if (candidateFields.transportMode !== 'Sin medio de transporte') return null;
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
  const aiCandidateFields = normalizeAiFields(aiFields);
  const aiEvidence = aiResult?.extraction?.fieldEvidence || {};
  const aiCity = typeof aiFields.city === 'string' ? aiFields.city.trim() || null : null;
  const aiRoleHint = typeof aiFields.roleHint === 'string' ? aiFields.roleHint.trim() || null : null;
  const extractionWasUseful = aiResult?.status === 'ok' && (Object.keys(aiCandidateFields).length > 0 || aiCity || aiRoleHint || aiResult.intent);

  if (extractionWasUseful) {
    understanding.candidateFields = aiCandidateFields;
    understanding.intent = Object.keys(aiCandidateFields).length ? 'provide_data' : (aiResult.intent || 'unknown');
    understanding.suggestedNextAction = Object.keys(aiCandidateFields).length ? 'collect_or_confirm' : 'ask_for_clarification';
    understanding.fieldConfidence = buildConfidenceFromEvidence(aiCandidateFields, aiEvidence);
  } else {
    const localParsed = parseNaturalData(input);
    const normalized = normalizeCandidateFields(localParsed);
    understanding.candidateFields = compactFields(normalized);
    understanding.intent = Object.keys(understanding.candidateFields).length ? 'provide_data' : 'unknown';
    understanding.suggestedNextAction = Object.keys(understanding.candidateFields).length ? 'collect_or_confirm' : 'ask_for_clarification';
    for (const field of Object.keys(understanding.candidateFields)) {
      understanding.fieldConfidence[field] = 0.7;
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

  return understanding;
}
