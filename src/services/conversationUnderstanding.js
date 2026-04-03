import { normalizeCandidateFields, parseNaturalData } from './candidateData.js';
import { detectVacancyAndCity } from './vacancyCatalog.js';

const EMPTY_UNDERSTANDING = Object.freeze({
  intent: 'unknown',
  vacancyDetection: { detected: false, vacancyKey: null, confidence: 0, source: 'none', alternatives: [] },
  cityDetection: { detected: false, cityKey: null, confidence: 0, source: 'none' },
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

function detectCorrectionIntent(text = '') {
  return /\b(corrijo|correccion|corrijo|de hecho|mejor|actualizo|quise decir|perdon|perd[oó]n)\b/i.test(String(text || ''));
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

  const localParsed = parseNaturalData(input);
  const normalized = normalizeCandidateFields(localParsed);

  understanding.candidateFields = normalized;
  understanding.intent = Object.keys(normalized).length ? 'provide_data' : 'unknown';
  understanding.suggestedNextAction = Object.keys(normalized).length ? 'collect_or_confirm' : 'ask_for_clarification';

  if (detectCorrectionIntent(input)) {
    understanding.intent = 'provide_correction';
    understanding.corrections.push({ source: 'text', reason: 'explicit_correction_phrase' });
  }

  const contradiction = findTransportContradiction(normalized);
  if (contradiction) understanding.contradictions.push(contradiction);

  for (const field of Object.keys(normalized)) {
    understanding.fieldConfidence[field] = 0.9;
  }

  const vacancyContext = detectVacancyAndCity({
    text: input,
    activeVacancies: options.activeVacancies || [],
    currentVacancyKey: options.currentVacancyKey || null
  });

  understanding.vacancyDetection = vacancyContext.vacancyDetection;
  understanding.cityDetection = {
    ...vacancyContext.cityDetection,
    detected: Boolean(vacancyContext.cityDetection?.cityKey)
  };

  if (!understanding.vacancyDetection.detected && vacancyContext.suggestedNextAction === 'ask_which_vacancy') {
    understanding.suggestedNextAction = 'ask_which_vacancy';
    understanding.replyGuidance.goal = 'resolve_vacancy';
  }

  if (typeof options.aiParser === 'function') {
    const aiResult = await options.aiParser(input);
    if (aiResult?.intent) understanding.intent = aiResult.intent;
  }

  return understanding;
}
