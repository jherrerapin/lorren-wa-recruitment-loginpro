import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderState } from '@prisma/client';
import { pauseCandidateAutomationForManualReview } from '../src/services/candidateStateService.js';

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
          && state.botPaused === where.botPaused
          && matchesDate(state.botPausedAt, where.botPausedAt)
          && state.botPausedBy === where.botPausedBy
          && state.botPauseReason === where.botPauseReason
          && state.botResumeMode === where.botResumeMode
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
    id: 'candidate-manual-review-pause-1',
    botPaused: false,
    botPausedAt: null,
    botPausedBy: 'reclutador-general',
    botPauseReason: null,
    botResumeMode: 'manual_resume_dashboard',
    reminderScheduledFor: new Date('2026-07-22T14:00:00.000Z'),
    reminderState: ReminderState.SCHEDULED,
    ...overrides
  };
}

function input(snapshot, overrides = {}) {
  return {
    candidateId: snapshot.id,
    expected: {
      botPaused: snapshot.botPaused,
      botPausedAt: snapshot.botPausedAt,
      botPausedBy: snapshot.botPausedBy,
      botPauseReason: snapshot.botPauseReason,
      botResumeMode: snapshot.botResumeMode,
      reminderScheduledFor: snapshot.reminderScheduledFor,
      reminderState: snapshot.reminderState
    },
    reason: 'Duda posterior requiere intervención manual',
    pausedAt: new Date('2026-07-22T01:58:00.000Z'),
    ...overrides
  };
}

test('pausa por revisión manual con snapshot exacto y escribe solo cinco campos', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);
  const result = await pauseCandidateAutomationForManualReview(client, input(snapshot));

  assert.equal(result.count, 1);
  assert.deepEqual(client.calls.updateMany[0].data, {
    botPaused: true,
    botPausedAt: new Date('2026-07-22T01:58:00.000Z'),
    botPauseReason: 'Duda posterior requiere intervención manual',
    reminderScheduledFor: null,
    reminderState: ReminderState.CANCELLED
  });
  assert.equal(result.candidate.botPausedBy, 'reclutador-general');
  assert.equal(result.candidate.botResumeMode, 'manual_resume_dashboard');
  assert.equal(client.calls.transaction, 0);
});

test('una carrera por cualquier campo observado devuelve count cero', async () => {
  const expected = candidate();
  const races = [
    { botPausedAt: new Date('2026-07-22T01:40:00.000Z') },
    { botPausedBy: 'devloginpro' },
    { botPauseReason: 'Otra revisión' },
    { botResumeMode: null },
    { reminderScheduledFor: new Date('2026-07-23T14:00:00.000Z') },
    { reminderState: ReminderState.SENT }
  ];

  for (const race of races) {
    const client = createClient(candidate(race));
    const result = await pauseCandidateAutomationForManualReview(client, input(expected));
    assert.equal(result.count, 0);
    assert.equal(client.calls.updateMany.length, 1);
    assert.deepEqual(client.getState(), candidate(race));
  }
});

test('candidato ya pausado produce no-op sin escritura', async () => {
  const snapshot = candidate({
    botPaused: true,
    botPausedAt: new Date('2026-07-22T01:50:00.000Z'),
    botPauseReason: 'Revisión vigente'
  });
  const client = createClient(snapshot);
  const result = await pauseCandidateAutomationForManualReview(client, input(snapshot));
  assert.equal(result.count, 0);
  assert.equal(result.blockedReason, 'already_paused');
  assert.equal(client.calls.updateMany.length, 0);
});

test('acepta fechas nulas del snapshot', async () => {
  const snapshot = candidate({ reminderScheduledFor: null, reminderState: ReminderState.NONE });
  const client = createClient(snapshot);
  const result = await pauseCandidateAutomationForManualReview(client, input(snapshot));
  assert.equal(result.count, 1);
  assert.equal(client.calls.updateMany[0].where.botPausedAt, null);
  assert.equal(client.calls.updateMany[0].where.reminderScheduledFor, null);
});

test('rechaza cliente, snapshot, razón y fecha inválidos antes de escribir', async () => {
  const snapshot = candidate();
  const valid = input(snapshot);
  const cases = [
    [{}, valid, /candidate_state_client_required/],
    [createClient(snapshot), { ...valid, candidateId: '' }, /candidate_id_required/],
    [createClient(snapshot), { ...valid, expected: null }, /candidate_manual_review_pause_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: [] }, /candidate_manual_review_pause_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, botPaused: 'no' } }, /candidate_expected_pause_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, botPausedBy: 7 } }, /candidate_manual_review_pause_expected_bot_paused_by_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, botResumeMode: 7 } }, /candidate_manual_review_pause_expected_resume_mode_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderState: 'INVALID' } }, /candidate_manual_review_pause_reminder_state_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderScheduledFor: true } }, /candidate_manual_review_pause_reminder_scheduled_for_invalid/],
    [createClient(snapshot), { ...valid, reason: '   ' }, /candidate_manual_review_pause_reason_required/],
    [createClient(snapshot), { ...valid, pausedAt: 'not-a-date' }, /candidate_manual_review_pause_at_invalid/]
  ];

  for (const [client, args, pattern] of cases) {
    await assert.rejects(() => pauseCandidateAutomationForManualReview(client, args), pattern);
    assert.equal(client.calls?.updateMany?.length || 0, 0);
  }
});
