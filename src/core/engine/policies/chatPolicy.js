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
    ? input.pending.fields.filter((field) => typeof field === 'string' && field.trim())
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
    const text = buildPendingFieldsReply(pendingFields);
    return text ? { reply: { text } } : {};
  }

  if (GREETING_INTENTS.has(intent)) {
    return {
      reply: {
        text: 'Hola. Cuéntame cómo puedo ayudarte con tu proceso de selección.'
      }
    };
  }

  if (ACKNOWLEDGEMENT_INTENTS.has(intent)) {
    return {
      reply: {
        text: 'Con gusto. Si necesitas revisar algo más de tu proceso, cuéntame.'
      }
    };
  }

  return {};
}

export default chatPolicy;
