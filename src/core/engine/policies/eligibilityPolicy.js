const AGE_REJECTION_REPLY =
  'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque no cumples con el requisito de edad definido para esta vacante.';

function candidateFacts(input = {}) {
  const facts = input?.candidate?.facts;
  return facts && typeof facts === 'object' && !Array.isArray(facts)
    ? facts
    : {};
}

function interpretedFields(input = {}) {
  const fields = input?.interpretation?.fields;
  return fields && typeof fields === 'object' && !Array.isArray(fields)
    ? fields
    : {};
}

function finiteInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : null;
}

function candidateAge(input = {}) {
  const extracted = finiteInteger(interpretedFields(input).age);
  if (extracted !== null) return extracted;
  return finiteInteger(candidateFacts(input).age);
}

function isOutsideAgeRange(age, vacancy = null) {
  if (age === null || !vacancy) return false;

  const minAge = finiteInteger(vacancy.minAge);
  const maxAge = finiteInteger(vacancy.maxAge);

  if (minAge !== null && age < minAge) return true;
  if (maxAge !== null && age > maxAge) return true;
  return false;
}

/**
 * Pure age-eligibility policy.
 *
 * Current-turn extracted age has precedence over the persisted snapshot so the
 * decision is not one turn behind. No external state is queried or mutated.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function eligibilityPolicy(input) {
  const age = candidateAge(input);

  if (!isOutsideAgeRange(age, input?.vacancy)) {
    return {};
  }

  return {
    ...(input?.execution?.mayReply === true
      ? {
          reply: {
            text: AGE_REJECTION_REPLY
          }
        }
      : {}),
    mutations: {
      fieldsToPersist: {
        status: 'REGISTRADO'
      }
    },
    transitions: {
      endConversation: true
    }
  };
}

export default eligibilityPolicy;
