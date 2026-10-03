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
const INFORMATION_DIRECTIVES = Object.freeze({
  ASK_VACANCY_INFORMATION: 'ANSWER_VACANCY_INFORMATION',
  ASK_VACANCY_SCHEDULE: 'ANSWER_VACANCY_SCHEDULE',
  ASK_APPLICATION_STATUS: 'ANSWER_APPLICATION_STATUS',
  ASK_CV_SUBMISSION: 'EXPLAIN_CV_SUBMISSION'
});
const PERSISTABLE_FIELDS = new Set([
  'vacancyId', 'recruitmentCity', 'recruitmentRole', 'fullName', 'locality', 'neighborhood',
  'documentType', 'documentNumber', 'age', 'gender', 'medicalRestrictions',
  'transportMode', 'experienceInfo', 'experienceTime', 'experienceSummary'
]);

export function isSystemReminderIntent(input = {}) {
  return SYSTEM_REMINDER_INTENTS.has(getIntent(input));
}

const FIELD_LABELS = Object.freeze({
  recruitmentCity: 'ciudad',
  recruitmentRole: 'vacante o cargo que viste',
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
      .filter((field) => !['dataConsent', 'gender', 'vacancyId'].includes(field.trim()))
    : [];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSerializable(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSerializable);
  return isRecord(value) && Object.values(value).every(isSerializable);
}

function providedFields(interpretation = {}) {
  const merged = {
    ...asFields(interpretation.extractedFields),
    ...asFields(interpretation.detectedFields),
    ...asFields(interpretation.providedFields),
    ...asFields(interpretation.fields)
  };
  return Object.fromEntries(Object.entries(merged).filter(([field, value]) => (
    PERSISTABLE_FIELDS.has(field) && isSerializable(value)
  )));
}

function asFields(value) {
  return isRecord(value) ? value : {};
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
export function chatPolicy(input) {
  const intent = getIntent(input);

  if (isSystemReminderIntent(input)) {
    return {
      reply: {
        directive: 'SEND_REMINDER',
        parameters: { reminderType: intent }
      }
    };
  }

  const interpretation = isRecord(input?.interpretation) ? input.interpretation : null;
  const reminderMutation = input?.candidate?.facts?.inactivityReminderSent === true
    ? { inactivityReminderSent: false }
    : {};
  if (!interpretation) {
    return Object.keys(reminderMutation).length
      ? { mutations: { fieldsToPersist: reminderMutation } }
      : {};
  }

  const fieldsToPersist = { ...reminderMutation, ...providedFields(interpretation) };

  if (FINALIZATION_INTENTS.has(intent)) {
    return {
      transitions: {
        endConversation: true
      }
    };
  }

  if (input?.execution?.mayReply === false) {
    return Object.keys(fieldsToPersist).length ? { mutations: { fieldsToPersist } } : {};
  }

  const pendingFields = getPendingFields(input).filter((field) => (
    !Object.prototype.hasOwnProperty.call(fieldsToPersist, field)
  ));
  if (pendingFields.length) {
    const text = buildPendingFieldsReply(pendingFields);
    return {
      reply: { text },
      ...(Object.keys(fieldsToPersist).length
        ? { mutations: { fieldsToPersist } }
        : {}),
      transitions: { keepCurrentStep: true }
    };
  }

  if (INFORMATION_DIRECTIVES[intent]) {
    return {
      reply: { directive: INFORMATION_DIRECTIVES[intent] },
      ...(Object.keys(fieldsToPersist).length ? { mutations: { fieldsToPersist } } : {})
    };
  }

  if (intent === 'CORRECT_CANDIDATE_DATA') {
    return {
      reply: { directive: 'ACKNOWLEDGE_CORRECTION' },
      ...(Object.keys(fieldsToPersist).length ? { mutations: { fieldsToPersist } } : {})
    };
  }

  if (Object.keys(fieldsToPersist).length) {
    const hasConversationalField = Object.keys(fieldsToPersist)
      .some((field) => field !== 'gender' && field !== 'inactivityReminderSent');
    return {
      ...(hasConversationalField && intent
        ? { reply: { directive: 'ACKNOWLEDGE_DATA' } }
        : {}),
      mutations: { fieldsToPersist }
    };
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
