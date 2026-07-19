import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, ReminderState } from '@prisma/client';
import { applyCandidateVacancyFirstGateDecision } from '../src/services/candidateStateService.js';

const REMINDER_AT = new Date('2026-07-19T15:00:00.000Z');
const EXPECTED = Object.freeze({
  currentStep: ConversationStep.GREETING_SENT,
  vacancyId: null,
  botResumeMode: 'alternative_vacancy_offer:vacancy-1',
  reminderScheduledFor: REMINDER_AT,
  reminderState: ReminderState.SCHEDULED
});

function createClient({ count = 1, candidate = null } = {}) {
  const calls = { updateMany: [], findUnique: [] };
  return {
    calls,
    client: {
      candidate: {
        updateMany: async (args) => {
          calls.updateMany.push(args);
          return { count };
        },
        findUnique: async (args) => {
          calls.findUnique.push(args);
          return candidate || { id: args.where.id, ...EXPECTED };
        }
      }
    }
  };
}

test('aplica una decisión con snapshot completo y campos permitidos', async () => {
  const { client, calls } = createClient({
    candidate: {
      id: 'candidate-gate-1',
      currentStep: ConversationStep.COLLECTING_DATA,
      vacancyId: 'vacancy-1',
      botResumeMode: null,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });
  const result = await applyCandidateVacancyFirstGateDecision(client, {
    candidateId: 'candidate-gate-1',
    expected: EXPECTED,
    update: {
      currentStep: ConversationStep.COLLECTING_DATA,
      vacancyId: 'vacancy-1',
      botResumeMode: null,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });
  assert.equal(result.count, 1);
  assert.equal(calls.updateMany.length, 1);
  assert.equal(calls.updateMany[0].where.id, 'candidate-gate-1');
  assert.equal(calls.updateMany[0].where.currentStep, ConversationStep.GREETING_SENT);
  assert.equal(calls.updateMany[0].where.vacancyId, null);
  assert.equal(calls.updateMany[0].where.botResumeMode, EXPECTED.botResumeMode);
  assert.equal(calls.updateMany[0].where.reminderState, ReminderState.SCHEDULED);
  assert.deepEqual(calls.updateMany[0].where.reminderScheduledFor, {
    gte: REMINDER_AT,
    lt: new Date(REMINDER_AT.getTime() + 1)
  });
  assert.equal(calls.updateMany[0].data.currentStep, ConversationStep.COLLECTING_DATA);
  assert.equal(result.candidate.vacancyId, 'vacancy-1');
});

test('permite el mismo paso cuando cambia otro campo del contrato', async () => {
  const { client, calls } = createClient();
  const result = await applyCandidateVacancyFirstGateDecision(client, {
    candidateId: 'candidate-gate-2',
    expected: { ...EXPECTED, reminderScheduledFor: null, reminderState: ReminderState.NONE },
    update: {
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: 'future_profile_offer'
    }
  });
  assert.equal(result.count, 1);
  assert.equal(calls.updateMany[0].data.currentStep, ConversationStep.GREETING_SENT);
  assert.equal(calls.updateMany[0].data.botResumeMode, 'future_profile_offer');
});

test('un conflicto devuelve el candidato observado sin reintentar', async () => {
  const observed = {
    id: 'candidate-gate-3',
    currentStep: ConversationStep.ASK_CV,
    vacancyId: 'vacancy-new',
    botResumeMode: null,
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE
  };
  const { client, calls } = createClient({ count: 0, candidate: observed });
  const result = await applyCandidateVacancyFirstGateDecision(client, {
    candidateId: 'candidate-gate-3',
    expected: { ...EXPECTED, reminderScheduledFor: null, reminderState: ReminderState.NONE },
    update: { currentStep: ConversationStep.COLLECTING_DATA, vacancyId: 'vacancy-old' }
  });
  assert.equal(result.count, 0);
  assert.equal(result.candidate, observed);
  assert.equal(calls.updateMany.length, 1);
  assert.equal(calls.findUnique.length, 1);
});

test('rechaza snapshots, campos y destinos fuera del contrato', async () => {
  const { client, calls } = createClient();
  await assert.rejects(
    () => applyCandidateVacancyFirstGateDecision(client, {
      candidateId: 'candidate-gate-4',
      expected: { currentStep: ConversationStep.GREETING_SENT },
      update: { currentStep: ConversationStep.COLLECTING_DATA }
    }),
    /candidate_vacancy_first_gate_snapshot_required/
  );
  await assert.rejects(
    () => applyCandidateVacancyFirstGateDecision(client, {
      candidateId: 'candidate-gate-4',
      expected: EXPECTED,
      update: { currentStep: ConversationStep.COLLECTING_DATA, status: 'REGISTRADO' }
    }),
    /candidate_vacancy_first_gate_update_field_not_allowed:status/
  );
  await assert.rejects(
    () => applyCandidateVacancyFirstGateDecision(client, {
      candidateId: 'candidate-gate-4',
      expected: EXPECTED,
      update: { currentStep: ConversationStep.DONE }
    }),
    /candidate_vacancy_first_gate_next_step_invalid/
  );
  await assert.rejects(
    () => applyCandidateVacancyFirstGateDecision(client, {
      candidateId: 'candidate-gate-4',
      expected: EXPECTED,
      update: { vacancyId: 'vacancy-1' }
    }),
    /candidate_vacancy_first_gate_current_step_required/
  );
  assert.equal(calls.updateMany.length, 0);
});
