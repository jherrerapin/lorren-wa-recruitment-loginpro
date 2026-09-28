const FINALIZATION_INTENTS = new Set([
  'END_CONVERSATION',
  'FAREWELL',
  'CANCEL_APPLICATION',
  'STOP_APPLICATION',
  'DECLINE_PROCESS'
]);

const GREETING_INTENTS = new Set([
  'GREETING',
  'HELLO'
]);

const ACKNOWLEDGEMENT_INTENTS = new Set([
  'ACKNOWLEDGEMENT',
  'THANKS',
  'SOFT_CONFIRMATION'
]);

const SYSTEM_REMINDER_INTENTS = new Set(['INACTIVITY_REMINDER', 'INTERVIEW_REMINDER']);

export function isSystemReminderIntent(input = {}) {
  return SYSTEM_REMINDER_INTENTS.has(getIntent(input));
}

const FIELD_LABELS = Object.freeze({
  fullName: 'nombre completo',
  documentType: 'tipo de documento',
  documentNumber: 'número de documento',
  age: 'edad',
  locality: 'localidad',
  neighborhood: 'barrio o sector de residencia',
  transportMode: 'medio de transporte',
  experienceInfo: 'experiencia',
  experienceTime: 'tiempo de experiencia',
  medicalRestrictions: 'restricciones médicas'
});

function getIntent(input = {}) {
  return String(input?.interpretation?.intent || '').trim().toUpperCase();
}

function getPendingFields(input = {}) {
  return Array.isArray(input?.pending?.fields)
    ? input.pending.fields
      .filter((field) => typeof field === 'string' && field.trim())
      .filter((field) => !['dataConsent', 'gender'].includes(field.trim()))
    : [];
}

function fieldLabel(field = '') {
  const key = String(field || '').trim();
  return FIELD_LABELS[key] || key;
}

function buildPendingFieldsReply(fields = []) {
  const labels = fields.map(fieldLabel).filter(Boolean);
  if (!labels.length) return '';
  if (labels.length === 1) return `Para continuar, compárteme tu ${labels[0]}.`;

  const last = labels.at(-1);
  const previous = labels.slice(0, -1);
  return `Para continuar, compárteme ${previous.join(', ')} y ${last}.`;
}

/**
 * Pure conversational fallback policy.
 * Specialized policies run after this one and may deterministically replace
 * its reply when the turn belongs to consent or vacancy-specific handling.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function chatPolicy(input) {
  const intent = getIntent(input);

  if (isSystemReminderIntent(input)) {
    return {
      reply: {
        directive: 'SEND_REMINDER',
        parameters: { reminderType: intent }
      }
    };
  }

  if (input?.candidate?.facts?.dataConsentStatus !== 'ACCEPTED') {
    return {};
  }

  const reminderMutation = input?.candidate?.facts?.inactivityReminderSent === true
    ? { mutations: { fieldsToPersist: { inactivityReminderSent: false } } }
    : {};

  if (FINALIZATION_INTENTS.has(intent)) {
    return {
      transitions: {
        endConversation: true
      }
    };
  }

  if (input?.execution?.mayReply !== true) return {};

  const pendingFields = getPendingFields(input);
  if (pendingFields.length) {
    return {
      ...reminderMutation,
      reply: {
        directive: 'ASK_MISSING_FIELDS',
        parameters: { missingFields: pendingFields }
      },
      transitions: { keepCurrentStep: true }
    };
  }

  if (GREETING_INTENTS.has(intent)) {
    return {
      reply: {
        text: 'Hola. Cuéntame cómo puedo ayudarte con tu proceso de selección.'
      },
      ...reminderMutation
    };
  }

  if (ACKNOWLEDGEMENT_INTENTS.has(intent)) {
    return {
      reply: {
        text: 'Con gusto. Si necesitas revisar algo más de tu proceso, cuéntame.'
      },
      ...reminderMutation
    };
  }

  return reminderMutation;
}

export default chatPolicy;
