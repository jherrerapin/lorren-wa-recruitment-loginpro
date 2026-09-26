const CV_REQUEST_REPLY =
  'Para continuar, adjunta tu hoja de vida como archivo PDF o DOCX.';

const REGISTRATION_COMPLETE_REPLY =
  'Tu información y hoja de vida quedaron registradas correctamente. El equipo de selección revisará tu perfil y, si el proceso continúa, te contactará por este medio.';

const INTERVIEW_LIFECYCLE_INTENTS = new Set([
  'CANCEL_INTERVIEW',
  'CANCEL_BOOKING',
  'CANCEL_ATTENDANCE',
  'RESCHEDULE_INTERVIEW',
  'REQUEST_RESCHEDULE',
  'CONFIRM_ATTENDANCE'
]);

function candidateFacts(input = {}) {
  const facts = input?.candidate?.facts;
  return facts && typeof facts === 'object' && !Array.isArray(facts)
    ? facts
    : {};
}

function interpretationFields(input = {}) {
  const fields = input?.interpretation?.fields;
  return fields && typeof fields === 'object' && !Array.isArray(fields)
    ? fields
    : {};
}

function intentOf(input = {}) {
  return String(input?.interpretation?.intent || '').trim().toUpperCase();
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function remainingPendingFields(input = {}) {
  const facts = candidateFacts(input);
  const extracted = interpretationFields(input);
  const pending = Array.isArray(input?.pending?.fields)
    ? input.pending.fields
    : [];

  return pending.filter((field) => (
    !hasValue(extracted[field])
    && !hasValue(facts[field])
  ));
}

function hasCvEvidence(input = {}) {
  const facts = candidateFacts(input);

  return input?.attachments?.hasCv === true
    || hasValue(facts.cvStorageKey);
}

function schedulingEnabled(vacancy = null) {
  if (!vacancy) return false;
  return vacancy.schedulingEnabled === true
    || vacancy.interviewSchedulingEnabled === true;
}

function hasResolvedVacancy(input = {}) {
  const facts = candidateFacts(input);
  return Boolean(facts.vacancyId || input?.vacancy?.id);
}

function shouldDeferCandidateFacingProgression(intent = '') {
  return intent.startsWith('ASK_VACANCY_')
    || intent === 'DEFER_PROCESS'
    || intent === 'OBJECTION'
    || intent === 'UNSUPPORTED_INPUT';
}

function hasExplicitSchedulingSlot(input = {}) {
  const slot = input?.interpretation?.scheduling?.slot;
  return Boolean(slot?.startsAt && slot?.timezone);
}

/**
 * Pure readiness/progression policy.
 *
 * `pending.fields` is the shell-provided readiness snapshot. Fields extracted
 * in the current turn are subtracted before progressing so state is not one
 * turn behind. Candidate-facing readiness is disabled until persisted consent
 * is ACCEPTED, so callers never need to filter pending fields or CV state.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function progressionPolicy(input) {
  if (input?.candidate?.facts?.dataConsentStatus !== 'ACCEPTED') {
    return {};
  }

  const facts = candidateFacts(input);
  const intent = intentOf(input);
  const currentStep = String(facts.currentStep || '').trim().toUpperCase();

  if (currentStep === 'DONE') {
    return {};
  }

  if (currentStep === 'SCHEDULED' && INTERVIEW_LIFECYCLE_INTENTS.has(intent)) {
    return {};
  }

  if (remainingPendingFields(input).length > 0) {
    return {
      scheduling: null
    };
  }

  if (!hasCvEvidence(input)) {
    if (shouldDeferCandidateFacingProgression(intent)) {
      return {
        scheduling: null
      };
    }

    return {
      reply: {
        text: CV_REQUEST_REPLY
      },
      scheduling: null
    };
  }

  if (!hasResolvedVacancy(input)) {
    return {
      scheduling: null
    };
  }

  if (currentStep === 'SCHEDULED') {
    return {};
  }

  if (schedulingEnabled(input?.vacancy)) {
    if (
      INTERVIEW_LIFECYCLE_INTENTS.has(intent)
      || hasExplicitSchedulingSlot(input)
    ) {
      return {};
    }

    return {
      scheduling: {
        action: 'suggest_slots'
      }
    };
  }

  if (shouldDeferCandidateFacingProgression(intent)) {
    return {};
  }

  return {
    reply: {
      text: REGISTRATION_COMPLETE_REPLY
    },
    transitions: {
      endConversation: true
    }
  };
}

export default progressionPolicy;
