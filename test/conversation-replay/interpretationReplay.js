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
  provide_correction: 'CORRECT_CANDIDATE_DATA'
});

function lastOutboundQuestion(history = []) {
  return [...history]
    .reverse()
    .find((message) => message?.direction === 'OUTBOUND')
    ?.body || '';
}

function resolveConsentDecision(fixture) {
  const candidate = fixture.initialState.candidate;
  if (candidate.dataConsentStatus === 'ACCEPTED') return null;

  const consentPromptPending = parseConsentPendingMode(candidate.botResumeMode).pending;
  const text = fixture.inbound.body;

  if (shouldRecordConsentRejection(text, { consentPromptPending })) return 'REVOKED';
  if (shouldRecordConsentAcceptance(text, { consentPromptPending })) return 'ACCEPTED';
  return null;
}

function canonicalIntent(runtimeIntent = '') {
  const normalized = String(runtimeIntent || '').trim().toLowerCase();
  return CANONICAL_INTENT_BY_RUNTIME[normalized] || normalized.toUpperCase();
}

function deriveAdditionalIntents(primaryIntent, turn) {
  const intents = [];
  if (turn.interest && primaryIntent !== 'CONTINUE_APPLICATION') intents.push('CONTINUE_APPLICATION');
  if (turn.correction && primaryIntent !== 'CORRECT_CANDIDATE_DATA') intents.push('CORRECT_CANDIDATE_DATA');
  if (turn.vacancyInformationRequest && !primaryIntent.startsWith('ASK_VACANCY_')) intents.push('ASK_VACANCY_INFORMATION');
  return intents;
}

export async function replayFixtureInterpretation(fixture) {
  const candidate = fixture.initialState.candidate;
  const vacancy = fixture.initialState.vacancy;
  const text = fixture.inbound.body;
  const context = {
    tenantContext: fixture.tenantContext,
    policyContext: fixture.policyContext,
    candidate,
    vacancy,
    currentStep: candidate.currentStep,
    pendingFields: fixture.initialState.pendingFields || [],
    lastBotQuestion: lastOutboundQuestion(fixture.history)
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
      consentDecision: resolveConsentDecision(fixture),
      providedFields: understanding.candidateFields
    },
    evidence: {
      turn,
      understanding
    }
  };
}
