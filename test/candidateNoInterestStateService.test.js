import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, ReminderState } from '@prisma/client';
import { completeCandidateNoInterestTransition } from '../src/services/candidateStateService.js';

function matchesDateFilter(actual, expected) {
  if (expected === null) return actual === null;
  const actualDate = actual instanceof Date ? actual : new Date(actual);
  return actualDate >= expected.gte && actualDate < expected.lt;
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
        const matches = state.id === args.where.id
          && state.currentStep === args.where.currentStep
          && state.reminderState === args.where.reminderState
          && matchesDateFilter(state.reminderScheduledFor, args.where.reminderScheduledFor);
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
    id: 'candidate-no-interest-1',
    currentStep: ConversationStep.ASK_CV,
    reminderScheduledFor: new Date('2026-07-21T14:00:00.000Z'),
    reminderState: ReminderState.SCHEDULED,
    ...overrides
  };
}

function transitionInput(snapshot) {
  return {
    candidateId: snapshot.id,
    expected: {
      currentStep: snapshot.currentStep,
      reminderScheduledFor: snapshot.reminderScheduledFor,
      reminderState: snapshot.reminderState
    }
  };
}

test('cierra por falta de interés con snapshot exacto y solo tres campos permitidos', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);

  const result = await completeCandidateNoInterestTransition(client, transitionInput(snapshot));

  assert.equal(result.count, 1);
  assert.equal(result.candidate.currentStep, ConversationStep.DONE);
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, ReminderState.SKIPPED);
  assert.deepEqual(client.calls.updateMany[0].data, {
    currentStep: ConversationStep.DONE,
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED
  });
  assert.deepEqual(client.calls.updateMany[0].where, {
    id: snapshot.id,
    currentStep: ConversationStep.ASK_CV,
    reminderScheduledFor: {
      gte: snapshot.reminderScheduledFor,
      lt: new Date(snapshot.reminderScheduledFor.getTime() + 1)
    },
    reminderState: ReminderState.SCHEDULED
  });
});

test('una carrera por currentStep conserva el estado vigente', async () => {
  const expected = candidate();
  const client = createClient(candidate({ currentStep: ConversationStep.CONFIRMING_DATA }));

  const result = await completeCandidateNoInterestTransition(client, transitionInput(expected));

  assert.equal(result.count, 0);
  assert.equal(result.candidate.currentStep, ConversationStep.CONFIRMING_DATA);
  assert.equal(result.candidate.reminderState, ReminderState.SCHEDULED);
});

test('una carrera por reminderState conserva el recordatorio vigente', async () => {
  const expected = candidate();
  const client = createClient(candidate({ reminderState: ReminderState.SENT }));

  const result = await completeCandidateNoInterestTransition(client, transitionInput(expected));

  assert.equal(result.count, 0);
  assert.equal(result.candidate.currentStep, ConversationStep.ASK_CV);
  assert.equal(result.candidate.reminderState, ReminderState.SENT);
});

test('una carrera por reminderScheduledFor conserva la fecha vigente', async () => {
  const expected = candidate();
  const newerDate = new Date('2026-07-22T14:00:00.000Z');
  const client = createClient(candidate({ reminderScheduledFor: newerDate }));

  const result = await completeCandidateNoInterestTransition(client, transitionInput(expected));

  assert.equal(result.count, 0);
  assert.equal(result.candidate.reminderScheduledFor.getTime(), newerDate.getTime());
  assert.equal(result.candidate.reminderState, ReminderState.SCHEDULED);
});

test('acepta snapshot con reminderScheduledFor nulo', async () => {
  const snapshot = candidate({ reminderScheduledFor: null, reminderState: ReminderState.NONE });
  const client = createClient(snapshot);

  const result = await completeCandidateNoInterestTransition(client, transitionInput(snapshot));

  assert.equal(result.count, 1);
  assert.equal(client.calls.updateMany[0].where.reminderScheduledFor, null);
});

test('rechaza clientes y snapshots inválidos antes de escribir', async () => {
  const snapshot = candidate();
  const valid = transitionInput(snapshot);
  const cases = [
    [{}, valid, /candidate_state_client_required/],
    [createClient(snapshot), { ...valid, expected: null }, /candidate_no_interest_reminder_scheduled_for_required/],
    [createClient(snapshot), { ...valid, expected: [] }, /candidate_no_interest_reminder_scheduled_for_required/],
    [createClient(snapshot), { ...valid, expected: 'invalid' }, /candidate_no_interest_reminder_scheduled_for_required/],
    [createClient(snapshot), { ...valid, candidateId: '' }, /candidate_id_required/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, currentStep: 'INVALID' } }, /candidate_no_interest_current_step_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, currentStep: ConversationStep.DONE } }, /candidate_no_interest_already_done/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderState: 'INVALID' } }, /candidate_no_interest_reminder_state_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderScheduledFor: true } }, /candidate_no_interest_reminder_scheduled_for_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderScheduledFor: 'not-a-date' } }, /candidate_no_interest_reminder_scheduled_for_invalid/]
  ];

  for (const [client, input, pattern] of cases) {
    await assert.rejects(() => completeCandidateNoInterestTransition(client, input), pattern);
    assert.equal(client.calls?.updateMany?.length || 0, 0);
  }
});

test('reutiliza el cliente recibido sin abrir una transacción anidada', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);

  await completeCandidateNoInterestTransition(client, transitionInput(snapshot));

  assert.equal(client.calls.transaction, 0);
});
