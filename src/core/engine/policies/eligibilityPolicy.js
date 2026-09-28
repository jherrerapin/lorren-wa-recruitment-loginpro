const AGE_REJECTION_REPLY =
  'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque no cumples con el requisito de edad definido para esta vacante.';
const EXPERIENCE_REJECTION_REPLY =
  'Gracias por tu interés. Esta vacante requiere experiencia previa y la información registrada no cumple ese requisito. Conservaremos tu postulación para futuras oportunidades compatibles.';
const FEMALE_VALUES = new Set(['FEMALE', 'FEMENINO', 'MUJER']);

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
export async function evaluateEligibility(input) {
  const intent = String(input?.interpretation?.intent || '').trim().toUpperCase();
  if (['INACTIVITY_REMINDER', 'INTERVIEW_REMINDER'].includes(intent)) return {};

  const facts = candidateFacts(input);
  const pending = new Set(Array.isArray(input?.pending?.fields) ? input.pending.fields : []);
  const age = candidateAge(input);

  if (isOutsideAgeRange(age, input?.vacancy)) {
    return {
      ...(input?.execution?.mayReply === true ? { reply: { text: AGE_REJECTION_REPLY } } : {}),
      mutations: { fieldsToPersist: { status: 'REGISTRADO' } },
      transitions: { endConversation: true }
    };
  }

  const experienceRequired = String(
    input?.vacancy?.experienceRequired ?? facts.experienceRequired ?? ''
  ).trim().toUpperCase();
  const experience = String(
    interpretedFields(input).experienceInfo ?? facts.experienceInfo ?? ''
  ).trim().toUpperCase();
  if (experienceRequired === 'YES' && !pending.has('experienceInfo')
    && ['NO', 'FALSE'].includes(experience)) {
    return {
      ...(input?.execution?.mayReply === true
        ? { reply: { text: EXPERIENCE_REJECTION_REPLY } }
        : {}),
      mutations: { fieldsToPersist: { status: 'REGISTRADO' } },
      transitions: { endConversation: true }
    };
  }

  const gender = String(interpretedFields(input).gender ?? facts.gender ?? '')
    .trim()
    .toUpperCase();
  const schedulingEnabled = input?.vacancy?.schedulingEnabled ?? facts.schedulingEnabled;
  if (pending.size === 0 && FEMALE_VALUES.has(gender) && schedulingEnabled === true) {
    return {
      reply: { directive: 'INFORM_MANUAL_REVIEW' },
      mutations: {
        fieldsToPersist: {
          gender: 'FEMALE',
          botPaused: true,
          botPauseReason: 'Candidata femenina pendiente de revision humana',
          reminderState: 'SKIPPED',
          reminderScheduledFor: null
        },
        nextStep: 'MANUAL_REVIEW'
      },
      transitions: { handoffToHuman: true },
      scheduling: { action: 'none' }
    }
  }

  return {};
}

export const eligibilityPolicy = evaluateEligibility;

export default eligibilityPolicy;
