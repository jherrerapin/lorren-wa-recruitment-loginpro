const ASSIGNMENT_INTENTS = new Set([
  'APPLY_INTENT',
  'PROVIDE_DATA'
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

  const exactAnchors = [
    vacancy.city,
    vacancy?.operation?.city?.name
  ]
    .map(normalize)
    .filter((value) => value.length >= 3);

  if (exactAnchors.some((anchor) => text.includes(anchor))) {
    return true;
  }

  const roleTokens = [
    ...significantTokens(vacancy.title),
    ...significantTokens(vacancy.role),
    ...significantTokens(vacancy?.operation?.name)
  ];

  return [...new Set(roleTokens)].some((token) => text.includes(token));
}

/**
 * Pure vacancy-assignment policy.
 *
 * The imperative shell/NLU remains responsible for resolving a candidate's
 * text/city/role evidence to one concrete vacancy snapshot. This policy only
 * decides whether that already-resolved vacancy id should become candidate
 * state, preventing the Functional Core from querying vacancy catalogs.
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

  const intent = interpretationIntent(input);
  if (!ASSIGNMENT_INTENTS.has(intent)) {
    return {};
  }

  const hasAssignmentEvidence = intent === 'APPLY_INTENT'
    || textSupportsResolvedVacancy(input);

  if (!hasAssignmentEvidence) {
    return {};
  }

  return {
    mutations: {
      fieldsToPersist: {
        vacancyId: resolvedVacancyId
      }
    }
  };
}

export default vacancyAssignmentPolicy;
