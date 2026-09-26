const CANDIDATE_MUTATION_FIELDS = Object.freeze([
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'gender',
  'neighborhood',
  'locality',
  'medicalRestrictions',
  'transportMode',
  'experienceInfo',
  'experienceTime',
  'experienceSummary'
]);

function isPersistableValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

/**
 * Pure projection from interpreted current-turn candidate entities into
 * declarative persistence mutations.
 *
 * This policy does not decide how or where fields are persisted. It only
 * exposes validated evidence already present in ConversationTurnInput so the
 * imperative shell can apply the resulting mutation atomically.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function candidateDataPolicy(input) {
  const extractedFields = input?.interpretation?.fields;
  if (!extractedFields || typeof extractedFields !== 'object' || Array.isArray(extractedFields)) {
    return {};
  }

  const fieldsToPersist = {};

  for (const field of CANDIDATE_MUTATION_FIELDS) {
    const value = extractedFields[field];
    if (!isPersistableValue(value)) continue;

    fieldsToPersist[field] = typeof value === 'string'
      ? value.trim()
      : value;
  }

  if (!Object.keys(fieldsToPersist).length) {
    return {};
  }

  return {
    mutations: {
      fieldsToPersist
    }
  };
}

export default candidateDataPolicy;
