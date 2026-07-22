import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, ReminderState } from '@prisma/client';
import {
  CANDIDATE_PAUSED_VACANCY_ACTIONS,
  applyCandidatePausedVacancyDecision
} from '../src/services/candidateStateService.js';

function matchesValue(actual, expected) {
  if (expected && typeof expected === 'object' && Object.hasOwn(expected, 'gte')) {
    if (actual == null) return false;
    const date = actual instanceof Date ? actual : new Date(actual);
    return date >= expected.gte && date < expected.lt;
  }
  return actual === expected;
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
        const matches = Object.entries(args.where).every(([field, expected]) => (
          field === 'id'
            ? state.id === expected
            : matchesValue(state[field], expected)
        ));
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
    id: 'candidate-paused-vacancy-1',
    currentStep: ConversationStep.MENU,
    vacancyId: 'vacancy-paused-1',
    botResumeMode: null,
    reminderScheduledFor: new Date('2026-07-23T14:00:00.000Z'),
    reminderState: ReminderState.SCHEDULED,
    ...overrides
  };
}

function input(snapshot, action, overrides = {}) {
  return {
    candidateId: snapshot.id,
    action,
    expected: {
      currentStep: snapshot.currentStep,
      vacancyId: snapshot.vacancyId,
      botResumeMode: snapshot.botResumeMode,
      reminderScheduledFor: snapshot.reminderScheduledFor,
      reminderState: snapshot.reminderState
    },
    ...overrides
  };
}

const actionCases = [
  {
    action: CANDIDATE_PAUSED_VACANCY_ACTIONS.REGISTRATION_OFFERED,
    snapshot: candidate(),
    expectedData: {
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: 'paused_vacancy',
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  },
  {
    action: CANDIDATE_PAUSED_VACANCY_ACTIONS.FUTURE_PROFILE_ACCEPTED,
    snapshot: candidate({
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: 'paused_vacancy'
    }),
    expectedData: {
      currentStep: ConversationStep.COLLECTING_DATA,
      botResumeMode: 'paused_vacancy_capture',
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  },
  {
    action: CANDIDATE_PAUSED_VACANCY_ACTIONS.FUTURE_PROFILE_DECLINED,
    snapshot: candidate({
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: 'paused_vacancy'
    }),
    expectedData: {
      currentStep: ConversationStep.DONE,
      botResumeMode: null,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  }
];

for (const item of actionCases) {
  test(`aplica destino fijo para ${item.action}`, async () => {
    const client = createClient(item.snapshot);
    const result = await applyCandidatePausedVacancyDecision(
      client,
      input(item.snapshot, item.action)
    );

    assert.equal(result.count, 1);
    assert.deepEqual(client.calls.updateMany[0].data, item.expectedData);
    assert.equal(result.nextStep, item.expectedData.currentStep);
    assert.equal(result.nextResumeMode, item.expectedData.botResumeMode);
    assert.equal(result.nextReminderState, ReminderState.SKIPPED);
  });
}

test('una carrera en cualquier campo observado conserva el estado vigente', async () => {
  const expected = candidate({
    currentStep: ConversationStep.GREETING_SENT,
    botResumeMode: 'paused_vacancy'
  });
  const races = [
    { currentStep: ConversationStep.CONFIRMING_DATA },
    { vacancyId: 'vacancy-concurrent-2' },
    { botResumeMode: 'manual_resume_dashboard' },
    { reminderScheduledFor: new Date('2026-07-24T14:00:00.000Z') },
    { reminderState: ReminderState.SENT }
  ];

  for (const race of races) {
    const current = candidate({
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: 'paused_vacancy',
      ...race
    });
    const client = createClient(current);
    const result = await applyCandidatePausedVacancyDecision(
      client,
      input(expected, CANDIDATE_PAUSED_VACANCY_ACTIONS.FUTURE_PROFILE_ACCEPTED)
    );

    assert.equal(result.count, 0);
    assert.deepEqual(client.getState(), current);
    assert.equal(client.calls.updateMany.length, 1);
  }
});

test('acepta vacante y fecha nulas en el snapshot de oferta', async () => {
  const snapshot = candidate({
    vacancyId: null,
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE
  });
  const client = createClient(snapshot);
  const result = await applyCandidatePausedVacancyDecision(
    client,
    input(snapshot, CANDIDATE_PAUSED_VACANCY_ACTIONS.REGISTRATION_OFFERED)
  );

  assert.equal(result.count, 1);
  assert.equal(client.calls.updateMany[0].where.vacancyId, null);
  assert.equal(client.calls.updateMany[0].where.reminderScheduledFor, null);
});

test('rechaza acciones, snapshots, modos y patches arbitrarios', async () => {
  const offered = candidate();
  const waiting = candidate({
    currentStep: ConversationStep.GREETING_SENT,
    botResumeMode: 'paused_vacancy'
  });
  const valid = input(offered, CANDIDATE_PAUSED_VACANCY_ACTIONS.REGISTRATION_OFFERED);
  const cases = [
    [createClient(offered), { ...valid, candidateId: '' }, /candidate_id_required/],
    [createClient(offered), { ...valid, action: 'UNKNOWN' }, /candidate_paused_vacancy_action_invalid/],
    [createClient(offered), { ...valid, expected: null }, /candidate_paused_vacancy_snapshot_required/],
    [createClient(offered), { ...valid, expected: [] }, /candidate_paused_vacancy_snapshot_required/],
    [createClient(offered), { ...valid, expected: { currentStep: offered.currentStep } }, /candidate_paused_vacancy_snapshot_required/],
    [createClient(offered), { ...valid, expected: { ...valid.expected, currentStep: 'INVALID' } }, /candidate_paused_vacancy_expected_step_invalid/],
    [createClient(offered), { ...valid, expected: { ...valid.expected, vacancyId: 123 } }, /candidate_paused_vacancy_expected_vacancy_id_invalid/],
    [createClient(offered), { ...valid, expected: { ...valid.expected, reminderScheduledFor: true } }, /candidate_paused_vacancy_expected_reminder_scheduled_for_invalid/],
    [createClient(offered), { ...valid, expected: { ...valid.expected, reminderState: 'INVALID' } }, /candidate_paused_vacancy_expected_reminder_state_invalid/],
    [createClient(offered), { ...valid, nextStep: ConversationStep.DONE }, /candidate_paused_vacancy_next_state_not_allowed/],
    [createClient(offered), { ...valid, nextResumeMode: null }, /candidate_paused_vacancy_next_state_not_allowed/],
    [createClient(offered), { ...valid, nextReminderState: ReminderState.NONE }, /candidate_paused_vacancy_next_state_not_allowed/],
    [createClient(offered), { ...valid, update: {} }, /candidate_paused_vacancy_patch_not_allowed/],
    [createClient(offered), { ...valid, data: {} }, /candidate_paused_vacancy_patch_not_allowed/],
    [createClient(offered), { ...valid, patch: {} }, /candidate_paused_vacancy_patch_not_allowed/],
    [
      createClient(offered),
      input(offered, CANDIDATE_PAUSED_VACANCY_ACTIONS.FUTURE_PROFILE_ACCEPTED),
      /candidate_paused_vacancy_waiting_mode_required/
    ],
    [
      createClient(waiting),
      input(waiting, CANDIDATE_PAUSED_VACANCY_ACTIONS.REGISTRATION_OFFERED, {
        expected: { ...input(waiting, CANDIDATE_PAUSED_VACANCY_ACTIONS.REGISTRATION_OFFERED).expected, botResumeMode: 'paused_vacancy_capture' }
      }),
      /candidate_paused_vacancy_capture_mode_not_offerable/
    ]
  ];

  await assert.rejects(
    () => applyCandidatePausedVacancyDecision({}, valid),
    /candidate_state_client_required/
  );

  for (const [client, args, pattern] of cases) {
    await assert.rejects(() => applyCandidatePausedVacancyDecision(client, args), pattern);
    assert.equal(client.calls.updateMany.length, 0);
  }
});

test('reutiliza Prisma o tx sin abrir una transacción anidada', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);
  await applyCandidatePausedVacancyDecision(
    client,
    input(snapshot, CANDIDATE_PAUSED_VACANCY_ACTIONS.REGISTRATION_OFFERED)
  );
  assert.equal(client.calls.transaction, 0);
});
