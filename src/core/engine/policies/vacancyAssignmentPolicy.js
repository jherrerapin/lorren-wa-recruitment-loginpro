const ASSIGNMENT_INTENTS = new Set([
  'APPLY_INTENT',
  'PROVIDE_DATA',
  'PROVIDE_CANDIDATE_DATA',
  'CONTINUE_APPLICATION'
]);

const TOKEN_STOPWORDS = new Set([
  'para',
  'como',
  'esta',
  'este',
  'vacante',
  'cargo',
  'oferta',
  'trabajo',
  'operacion',
  'loginpro',
  'service'
]);

function normalize(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function candidateFacts(input = {}) {
  const facts = input?.candidate?.facts;
  return facts && typeof facts === 'object' && !Array.isArray(facts)
    ? facts
    : {};
}

function interpretationIntent(input = {}) {
  return String(input?.interpretation?.intent || '').trim().toUpperCase();
}

function significantTokens(value = '') {
  return normalize(value)
    .split(' ')
    .filter((token) => token.length >= 4 && !TOKEN_STOPWORDS.has(token));
}

function textSupportsResolvedVacancy(input = {}) {
  const text = normalize(input?.turn?.rawText || '');
  const vacancy = input?.vacancy || {};
  if (!text) return false;

  const roleTokens = [
    ...significantTokens(vacancy.title),
    ...significantTokens(vacancy.role),
    ...significantTokens(vacancy?.operation?.name)
  ];

  const interpretation = input?.interpretation || {};
  const roleHints = [
    interpretation?.providedFields?.roleHint,
    interpretation?.detectedFields?.roleHint,
    interpretation?.extractedFields?.roleHint,
    interpretation?.fields?.recruitmentRole
  ]
    .map(normalize)
    .filter(Boolean);

  return [...new Set(roleTokens)].some((token) => (
    text.includes(token)
    || roleHints.some((hint) => hint.includes(token) || token.includes(hint))
  ));
}

function resolvedVacancyFields(input = {}) {
  const vacancy = input?.vacancy || {};
  const fields = {
    vacancyId: String(vacancy.id || '').trim()
  };
  const city = String(vacancy.city || vacancy?.operation?.city?.name || '').trim();
  const role = String(vacancy.role || vacancy.title || '').trim();
  if (city) fields.recruitmentCity = city;
  if (role) fields.recruitmentRole = role;
  return fields;
}

/**
 * Pure vacancy-assignment policy.
 *
 * The imperative shell/NLU remains responsible for resolving a candidate's
 * text/city/role evidence to one concrete vacancy snapshot. This policy only
 * decides whether that already-resolved vacancy should become candidate state.
 * Objective Meta attribution can be persisted without depending on text intent;
 * organic assignment still requires semantic evidence from the candidate turn.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function vacancyAssignmentPolicy(input) {
  const facts = candidateFacts(input);

  if (facts.vacancyId) {
    return {};
  }

  const resolvedVacancyId = String(input?.vacancy?.id || '').trim();
  if (!resolvedVacancyId) {
    return {};
  }

  const objectiveMetaAttribution = input?.attribution?.source === 'META_ADS';
  const intent = interpretationIntent(input);
  const hasAssignmentEvidence = objectiveMetaAttribution
    || ASSIGNMENT_INTENTS.has(intent) && (
      intent === 'APPLY_INTENT'
      || intent === 'CONTINUE_APPLICATION'
      || textSupportsResolvedVacancy(input)
    );

  if (!hasAssignmentEvidence) {
    return {};
  }

  return {
    mutations: {
      fieldsToPersist: resolvedVacancyFields(input)
    }
  };
}

export default vacancyAssignmentPolicy;
