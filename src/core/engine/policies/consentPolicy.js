import { CONSENT_REQUEST_TEXT } from '../../contracts/consentDefinition.js';

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

const SIMPLE_GREETING_INTENTS = new Set([
  'GREETING',
  'HELLO'
]);

const EXPLICIT_APPLICATION_INTENTS = new Set([
  'APPLY_INTENT'
]);

const CONSENT_REVOKED_REPLY =
  'Entendido. No continuaré con la postulación por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';

const CONSENT_BUTTONS = Object.freeze([
  Object.freeze({
    id: 'data_consent_accept',
    title: 'Sí autorizo'
  }),
  Object.freeze({
    id: 'data_consent_reject',
    title: 'No autorizo'
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

function isVacancyQuestion(input = {}) {
  const intent = interpretationIntent(input);
  return VACANCY_QUESTION_INTENTS.has(intent) || intent.startsWith('ASK_VACANCY_');
}

function hasExplicitConsentAcceptance(rawText = '') {
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

  return [
    /\b(no autorizo|no consiento)\b/,
    /\b(no doy mi consentimiento|no doy consentimiento|no doy permiso)\b/,
    /\b(no quiero autorizar|no deseo autorizar|no acepto)\b/,
    /\b(rechazo|revoco)\b.*\b(autorizacion|consentimiento|tratamiento|datos)\b/
  ].some((pattern) => pattern.test(normalized));
}

function resolvesConsentAcceptance(input = {}) {
  const intent = interpretationIntent(input);
  const decision = input?.interpretation?.consent?.decision;

  return CONSENT_ACCEPTANCE_INTENTS.has(intent)
    || decision === 'ACCEPTED'
    || hasExplicitConsentAcceptance(input?.turn?.rawText || '');
}

function resolvesConsentRejection(input = {}) {
  const intent = interpretationIntent(input);
  const decision = input?.interpretation?.consent?.decision;

  return CONSENT_REJECTION_INTENTS.has(intent)
    || decision === 'REJECTED'
    || decision === 'REVOKED'
    || hasExplicitConsentRejection(input?.turn?.rawText || '');
}

function isConsentPending(input = {}) {
  const facts = candidateFacts(input);
  const status = String(facts.dataConsentStatus || '').trim().toUpperCase();
  const interpretedDecision = input?.interpretation?.consent?.decision;

  if (interpretedDecision === 'PENDING') return true;
  if (status === 'ACCEPTED') return false;
  if (status === 'REVOKED' || status === 'REJECTED') return false;
  return true;
}

function hasResolvedVacancy(input = {}) {
  const facts = candidateFacts(input);
  return Boolean(facts.vacancyId || input?.vacancy?.id);
}

function isConsentPromptReady(input = {}) {
  const intent = interpretationIntent(input);
  if (!intent) return false;

  if (EXPLICIT_APPLICATION_INTENTS.has(intent)) {
    return true;
  }

  if (!hasResolvedVacancy(input)) {
    return false;
  }

  return !SIMPLE_GREETING_INTENTS.has(intent);
}

/**
 * Pure consent policy. It declares state mutations but never persists them.
 * Vacancy questions remain available to vacancyPolicy even while consent is
 * pending; consent controls progression, not comprehension of the current turn.
 *
 * A PENDING status alone is not enough to prompt. The conversation must first
 * have onboarding evidence: an explicitly expressed application intent or an
 * already resolved vacancy plus a non-greeting turn.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function consentPolicy(input) {
  if (resolvesConsentRejection(input)) {
    return {
      ...(input?.execution?.mayReply === true
        ? { reply: { text: CONSENT_REVOKED_REPLY } }
        : {}),
      mutations: {
        fieldsToPersist: {
          dataConsentStatus: 'REVOKED'
        }
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
          dataConsentStatus: 'ACCEPTED'
        }
      }
    };
  }

  if (!isConsentPending(input)) return {};
  if (isVacancyQuestion(input)) return {};
  if (!isConsentPromptReady(input)) return {};
  if (input?.execution?.mayReply !== true) return {};

  return {
    reply: {
      text: CONSENT_REQUEST_TEXT,
      buttons: CONSENT_BUTTONS
    }
  };
}

export default consentPolicy;
