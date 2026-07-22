import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, ReminderState } from '@prisma/client';
import { reflectCandidateInterviewRescheduleProgress } from '../src/services/candidateStateService.js';

function matchesDate(actual, expected) {
  if (expected === null) return actual === null;
  const date = actual instanceof Date ? actual : new Date(actual);
  return date >= expected.gte && date < expected.lt;
}

function createClient(initialState) {
  let state = { ...initialState };
  const calls = { updateMany: [], findUnique: [], transaction: 0 };
  return {
    calls,
    getState: () => ({ ...state }),
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        const where = args.where;
        const matches = state.id === where.id
          && state.currentStep === where.currentStep
          && matchesDate(state.reminderScheduledFor, where.reminderScheduledFor)
          && state.reminderState === where.reminderState;
        if (!matches) return { count: 0 };
        state = { ...state, ...args.data };
        return { count: 1 };
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return state.id === args.where.id ? { ...state } : null;
      }
    },
    $transaction: async () => {
      calls.transaction += 1;
      throw new Error('nested_transaction_not_allowed');
    }
  };
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-reschedule-progress-1',
    currentStep: ConversationStep.SCHEDULED,
    reminderScheduledFor: new Date('2026-07-23T14:00:00.000Z'),
    reminderState: ReminderState.SCHEDULED,
    ...overrides
  };
}

function input(snapshot, overrides = {}) {
  return {
    candidateId: snapshot.id,
    expected: {
      currentStep: snapshot.currentStep,
      reminderScheduledFor: snapshot.reminderScheduledFor,
      reminderState: snapshot.reminderState
    },
    ...overrides
  };
}

test('refleja la reprogramación con snapshot exacto y tres campos fijos', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);
  const result = await reflectCandidateInterviewRescheduleProgress(client, input(snapshot));

  assert.equal(result.count, 1);
  assert.deepEqual(client.calls.updateMany[0].data, {
    currentStep: ConversationStep.SCHEDULING,
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED
  });
  assert.equal(result.candidate.currentStep, ConversationStep.SCHEDULING);
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, ReminderState.SKIPPED);
});

test('una carrera por paso, fecha o estado conserva el candidato vigente', async () => {
  const expected = candidate();
  const races = [
    { currentStep: ConversationStep.SCHEDULING },
    { reminderScheduledFor: new Date('2026-07-24T14:00:00.000Z') },
    { reminderState: ReminderState.SENT }
  ];

  for (const race of races) {
    const current = candidate(race);
    const client = createClient(current);
    const result = await reflectCandidateInterviewRescheduleProgress(client, input(expected));
    assert.equal(result.count, 0);
    assert.deepEqual(client.getState(), current);
    assert.equal(client.calls.updateMany.length, 1);
  }
});

test('acepta recordatorio nulo en el snapshot', async () => {
  const snapshot = candidate({
    currentStep: ConversationStep.SCHEDULING,
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE
  });
  const client = createClient(snapshot);
  const result = await reflectCandidateInterviewRescheduleProgress(client, input(snapshot));

  assert.equal(result.count, 1);
  assert.equal(client.calls.updateMany[0].where.reminderScheduledFor, null);
});

test('rechaza clientes, snapshots, enums y patches arbitrarios inválidos', async () => {
  const snapshot = candidate();
  const valid = input(snapshot);
  const cases = [
    [{}, valid, /candidate_state_client_required/],
    [createClient(snapshot), { ...valid, candidateId: '' }, /candidate_id_required/],
    [createClient(snapshot), { ...valid, expected: null }, /candidate_interview_reschedule_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: [] }, /candidate_interview_reschedule_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: { currentStep: snapshot.currentStep, reminderState: snapshot.reminderState } }, /candidate_interview_reschedule_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, currentStep: ConversationStep.DONE } }, /candidate_interview_reschedule_expected_step_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, currentStep: 'INVALID' } }, /candidate_interview_reschedule_expected_current_step_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderScheduledFor: true } }, /candidate_interview_reschedule_expected_reminder_scheduled_for_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderState: 'INVALID' } }, /candidate_interview_reschedule_expected_reminder_state_invalid/],
    [createClient(snapshot), { ...valid, nextStep: ConversationStep.SCHEDULED }, /candidate_interview_reschedule_next_step_not_allowed/],
    [createClient(snapshot), { ...valid, update: {} }, /candidate_interview_reschedule_patch_not_allowed/],
    [createClient(snapshot), { ...valid, data: {} }, /candidate_interview_reschedule_patch_not_allowed/]
  ];

  for (const [client, args, pattern] of cases) {
    await assert.rejects(() => reflectCandidateInterviewRescheduleProgress(client, args), pattern);
    assert.equal(client.calls?.updateMany?.length || 0, 0);
  }
});

test('reutiliza Prisma o tx sin abrir una transacción anidada', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);
  await reflectCandidateInterviewRescheduleProgress(client, input(snapshot));
  assert.equal(client.calls.transaction, 0);
});
