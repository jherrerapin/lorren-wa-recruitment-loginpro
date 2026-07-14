import { analyzeConversationTurn } from '../../src/services/conversationIntent.js';
import { conversationUnderstanding } from '../../src/services/conversationUnderstanding.js';
import {
  parseConsentPendingMode,
  shouldRecordConsentAcceptance,
  shouldRecordConsentRejection
} from '../../src/services/dataConsentGate.js';

const CANONICAL_INTENT_BY_RUNTIME = Object.freeze({
  continue_application: 'CONTINUE_APPLICATION',
  ask_vacancy_schedule: 'ASK_VACANCY_SCHEDULE',
  provide_correction: 'CORRECT_CANDIDATE_DATA',
  accept_data_consent: 'ACCEPT_DATA_CONSENT',
  reject_data_consent: 'REJECT_DATA_CONSENT',
  send_attachment: 'SEND_ATTACHMENT'
});

const EXCLUSIVE_PRIMARY_INTENTS = new Set([
  'ACCEPT_DATA_CONSENT',
  'REJECT_DATA_CONSENT',
  'SEND_ATTACHMENT'
]);

function lastOutboundQuestion(history = []) {
  return [...history]
    .reverse()
    .find((message) => message?.direction === 'OUTBOUND')
    ?.body || '';
}

function inboundText(fixture) {
  return ['text', 'interactive'].includes(fixture.inbound.type)
    ? String(fixture.inbound.body || '')
    : String(fixture.inbound.caption || '');
}

function resolveConsentDecision(fixture, text) {
  const candidate = fixture.initialState.candidate;
  if (candidate.dataConsentStatus === 'ACCEPTED') return null;

  const consentPromptPending = parseConsentPendingMode(candidate.botResumeMode).pending;
  if (shouldRecordConsentRejection(text, { consentPromptPending })) return 'REVOKED';
  if (shouldRecordConsentAcceptance(text, { consentPromptPending })) return 'ACCEPTED';
  return null;
}

function canonicalIntent(runtimeIntent = '') {
  const normalized = String(runtimeIntent || '').trim().toLowerCase();
  const mappedIntent = CANONICAL_INTENT_BY_RUNTIME[normalized];
  return typeof mappedIntent === 'string' ? mappedIntent : normalized.toUpperCase();
}

function deriveAdditionalIntents(primaryIntent, turn) {
  if (EXCLUSIVE_PRIMARY_INTENTS.has(primaryIntent)) return [];

  const intents = [];
  if (turn.interest && primaryIntent !== 'CONTINUE_APPLICATION') intents.push('CONTINUE_APPLICATION');
  if (turn.correction && primaryIntent !== 'CORRECT_CANDIDATE_DATA') intents.push('CORRECT_CANDIDATE_DATA');
  if (turn.vacancyInformationRequest && !primaryIntent.startsWith('ASK_VACANCY_')) intents.push('ASK_VACANCY_INFORMATION');
  return intents;
}

export async function replayFixtureInterpretation(fixture) {
  const candidate = fixture.initialState.candidate;
  const vacancy = fixture.initialState.vacancy;
  const text = inboundText(fixture);
  const context = {
    tenantContext: fixture.tenantContext,
    policyContext: fixture.policyContext,
    candidate,
    vacancy,
    currentStep: candidate.currentStep,
    pendingFields: fixture.initialState.pendingFields || [],
    lastBotQuestion: lastOutboundQuestion(fixture.history),
    inboundType: fixture.inbound.type,
    attachment: fixture.inbound.attachment || null
  };

  const turn = analyzeConversationTurn(text, { currentStep: candidate.currentStep });
  const understanding = await conversationUnderstanding(text, {
    aiResult: fixture.providerStubs.aiResult,
    context
  });
  const intent = canonicalIntent(understanding.intent);

  return {
    tenantContext: fixture.tenantContext,
    policyContext: fixture.policyContext,
    interpretation: {
      intent,
      additionalIntents: deriveAdditionalIntents(intent, turn),
      consentDecision: resolveConsentDecision(fixture, text),
      providedFields: understanding.candidateFields
    },
    evidence: {
      turn,
      understanding,
      attachment: fixture.inbound.attachment ? structuredClone(fixture.inbound.attachment) : null
    }
  };
}
