import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateConversationDecision } from '../src/core/engine/calculateConversationDecision.js';

function systemInput(intent) {
  return {
    turn: {
      id: `system:${intent}`,
      receivedAt: '2026-09-24T12:00:00.000Z',
      rawText: '[SYSTEM_EVENT]'
    },
    candidate: {
      id: 'candidate-1',
      facts: {
        phone: '573001112233',
        dataConsentStatus: 'PENDING',
        vacancyActive: false,
        vacancyAcceptingApplications: false
      },
      updatedAt: '2026-09-24T09:00:00.000Z'
    },
    history: { messages: [], lastBotQuestion: null },
    pending: { fields: ['dataConsent', 'fullName', 'cv'], actions: [] },
    execution: {
      mayReply: true,
      mayPersistCandidate: true,
      maySendOutbound: true
    },
    interpretation: { intent }
  };
}

test('los recordatorios prevalecen sobre consentimiento, vacante y campos pendientes', async () => {
  for (const intent of ['INACTIVITY_REMINDER', 'INTERVIEW_REMINDER']) {
    const decision = await calculateConversationDecision(systemInput(intent));
    assert.deepEqual(decision.reply, {
      directive: 'SEND_REMINDER',
      parameters: { reminderType: intent }
    });
    assert.equal(decision.transitions.endConversation, false);
    assert.equal(decision.mutations.nextStep, null);
    assert.deepEqual(decision.mutations.fieldsToPersist, {});
  }
});
