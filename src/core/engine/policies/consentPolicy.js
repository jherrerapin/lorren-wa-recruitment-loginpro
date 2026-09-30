import {
  CONSENT_REQUEST_TEXT,
  CURRENT_CONSENT_VERSION
} from '../../contracts/consentDefinition.js';

const CONSENT_ACCEPTANCE_INTENTS = new Set([
  'ACCEPT_DATA_CONSENT',
  'CONSENT_ACCEPTED',
  'DATA_CONSENT_ACCEPTED'
]);

const CONSENT_REJECTION_INTENTS = new Set([
  'REJECT_DATA_CONSENT',
  'CONSENT_REJECTED',
  'DATA_CONSENT_REJECTED'
]);

const VACANCY_QUESTION_INTENTS = new Set([
  'ASK_VACANCY_INFORMATION',
  'ASK_VACANCY_COMPANY',
  'ASK_VACANCY_SALARY',
  'ASK_VACANCY_CONDITIONS',
  'ASK_VACANCY_REQUIREMENTS',
  'ASK_VACANCY_EXPERIENCE',
  'ASK_VACANCY_AGE',
  'ASK_VACANCY_FUNCTIONS',
  'ASK_VACANCY_LOCATION',
  'ASK_VACANCY_SCHEDULE'
]);

const EXPLICIT_APPLICATION_INTENTS = new Set([
  'APPLY_INTENT',
  'CONTINUE_APPLICATION'
]);

const AWAITING_VACANCY_INTEREST = 'awaiting_vacancy_interest';
const AWAITING_DATA_CONSENT = 'awaiting_data_consent';

const CONSENT_REVOKED_REPLY =
  'Entendido. No continuaré con la postulación por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';

const NOT_INTERESTED_REPLY =
  'Entendido. Gracias por tu tiempo. Si más adelante te interesa continuar con esta u otra convocatoria que hayas visto, puedes volver a escribirnos.';

const CONSENT_OPTIONS = Object.freeze([
  Object.freeze({
    id: `data_consent:${CURRENT_CONSENT_VERSION}:accept`,
    label: 'Sí autorizo'
  }),
  Object.freeze({
    id: `data_consent:${CURRENT_CONSENT_VERSION}:reject`,
    label: 'No autorizo'
  })
]);

function normalize(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function interpretationIntent(input = {}) {
  return String(input?.interpretation?.intent || '').trim().toUpperCase();
}

function candidateFacts(input = {}) {
  const facts = input?.candidate?.facts;
  return facts && typeof facts === 'object' && !Array.isArray(facts)
    ? facts
    : {};
}

function resumeMode(input = {}) {
  return String(candidateFacts(input).botResumeMode || '').trim().toLowerCase();
}

function isVacancyQuestion(input = {}) {
  const intent = interpretationIntent(input);
  return VACANCY_QUESTION_INTENTS.has(intent) || intent.startsWith('ASK_VACANCY_');
}

function hasExplicitConsentAcceptance(rawText = '') {
  if (/\?|\b(que pasa|que haran|como|para que|por que|cuales?)\b/i.test(normalize(rawText))) {
    return false;
  }
  const normalized = normalize(rawText);
  if (!normalized) return false;

  if (/\b(no autorizo|no consiento|no doy consentimiento|no doy mi consentimiento|no acepto|rechazo|revoco)\b/.test(normalized)) {
    return false;
  }

  return [
    /\b(autorizo|consiento)\b/,
    /\b(doy mi consentimiento|doy consentimiento|doy permiso|estoy de acuerdo)\b/,
    /\b(pueden|puede)\s+(usar|tratar|manejar|procesar|guardar)\s+(mis|los)\s+datos\b/
  ].some((pattern) => pattern.test(normalized));
}

function hasExplicitConsentRejection(rawText = '') {
  const normalized = normalize(rawText);
  if (!normalized) return false;
  if (/\?|\b(vacante|cargo|oferta)\b/.test(normalized)) return false;

  return [
    /\b(no autorizo|no consiento)\b/,
    /\b(no doy mi consentimiento|no doy consentimiento|no doy permiso)\b/,
    /\b(no quiero autorizar|no deseo autorizar|no acepto)\b/,
    /\b(rechazo|revoco)\b.*\b(autorizacion|consentimiento|tratamiento|datos)\b/
  ].some((pattern) => pattern.test(normalized));
}

function resolvesConsentAcceptance(input = {}) {
  const intent = interpretationIntent(input);
  const decision = input?.interpretation?.consentDecision
    ?? input?.interpretation?.consent?.decision;
  const shortAcceptance = /^(si|sí|acepto|de acuerdo)$/i.test(String(input?.turn?.rawText || '').trim());

  return CONSENT_ACCEPTANCE_INTENTS.has(intent)
    || decision === 'ACCEPTED'
    || (shortAcceptance && resumeMode(input) === AWAITING_DATA_CONSENT)
    || hasExplicitConsentAcceptance(input?.turn?.rawText || '');
}

function resolvesConsentRejection(input = {}) {
  const intent = interpretationIntent(input);
  const decision = input?.interpretation?.consentDecision
    ?? input?.interpretation?.consent?.decision;
  const shortRejection = /^(no|no gracias)$/i.test(String(input?.turn?.rawText || '').trim());

  return CONSENT_REJECTION_INTENTS.has(intent)
    || decision === 'REJECTED'
    || decision === 'REVOKED'
    || (shortRejection && resumeMode(input) === AWAITING_DATA_CONSENT)
    || hasExplicitConsentRejection(input?.turn?.rawText || '');
}

function resolvesPositiveInterest(input = {}) {
  const intent = interpretationIntent(input);
  const text = normalize(input?.turn?.rawText);
  if (EXPLICIT_APPLICATION_INTENTS.has(intent)) return true;
  if (/^(si|sí|claro|me interesa|estoy interesado|estoy interesada|quiero continuar|quiero postularme|deseo continuar)\b/.test(text)) {
    return true;
  }
  return false;
}

function resolvesNegativeInterest(input = {}) {
  const intent = interpretationIntent(input);
  const text = normalize(input?.turn?.rawText);
  if (['DECLINE_PROCESS', 'CANCEL_APPLICATION', 'STOP_APPLICATION', 'NO_INTEREST'].includes(intent)) {
    return true;
  }
  return /^(no|no gracias|no me interesa|ya no me interesa|prefiero no|no deseo continuar)\b/.test(text);
}

function isConsentPending(input = {}) {
  const status = String(candidateFacts(input).dataConsentStatus || '').trim().toUpperCase();
  return !['ACCEPTED', 'REVOKED', 'REJECTED'].includes(status);
}

function hasResolvedVacancy(input = {}) {
  const facts = candidateFacts(input);
  return Boolean(facts.vacancyId || input?.vacancy?.id);
}

/**
 * Consent is only requested after the vacancy is resolved and the candidate
 * has explicitly confirmed interest. Short yes/no answers only resolve legal
 * consent while botResumeMode says the consent question is actually pending.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export function consentPolicy(input) {
  if (['INACTIVITY_REMINDER', 'INTERVIEW_REMINDER'].includes(interpretationIntent(input))) {
    return {};
  }
  if (input?.vacancy === null || !hasResolvedVacancy(input)) return {};

  if (resolvesConsentRejection(input)) {
    return {
      ...(input?.execution?.mayReply !== false
        ? { reply: { text: CONSENT_REVOKED_REPLY, interactiveOptions: [] } }
        : {}),
      mutations: {
        fieldsToPersist: { botResumeMode: null }
      },
      transitions: {
        endConversation: true
      }
    };
  }

  if (resolvesConsentAcceptance(input)) {
    return {
      mutations: {
        fieldsToPersist: {
          dataConsentStatus: 'ACCEPTED',
          botResumeMode: null
        }
      }
    };
  }

  if (!isConsentPending(input)) return {};
  if (isVacancyQuestion(input)) return {};

  const mode = resumeMode(input);
  if (mode === AWAITING_VACANCY_INTEREST) {
    if (resolvesNegativeInterest(input)) {
      return {
        reply: { text: NOT_INTERESTED_REPLY, interactiveOptions: [] },
        mutations: {
          fieldsToPersist: { botResumeMode: null }
        },
        transitions: { endConversation: true }
      };
    }
    if (!resolvesPositiveInterest(input)) return {};

    return {
      reply: {
        text: CONSENT_REQUEST_TEXT,
        interactiveOptions: CONSENT_OPTIONS
      },
      mutations: {
        fieldsToPersist: { botResumeMode: AWAITING_DATA_CONSENT }
      },
      transitions: { keepCurrentStep: true }
    };
  }

  if (mode === AWAITING_DATA_CONSENT) {
    if (input?.execution?.mayReply === false) return {};
    if (['ACKNOWLEDGEMENT', 'SOFT_CONFIRMATION'].includes(interpretationIntent(input))) {
      return {
        reply: {
          text: CONSENT_REQUEST_TEXT,
          interactiveOptions: CONSENT_OPTIONS
        },
        transitions: { keepCurrentStep: true }
      };
    }
  }

  return {};
}

export default consentPolicy;
