import test from 'node:test';
import assert from 'node:assert/strict';
import { recordManualOutboundDelivery } from '../src/services/candidateStateService.js';

function sameValue(left, right) {
  if (left instanceof Date || right instanceof Date) {
    if (left == null || right == null) return left === right;
    return new Date(left).getTime() === new Date(right).getTime();
  }
  return left === right;
}

function createHarness(initialCandidate) {
  let state = { ...initialCandidate };
  const calls = { updateMany: [], findUnique: [], transactions: 0 };
  const client = {
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        const matches = Object.entries(args.where).every(([key, value]) => sameValue(state[key], value));
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
      calls.transactions += 1;
      throw new Error('nested_transaction_not_allowed');
    }
  };
  return { client, calls, getState: () => ({ ...state }), setState: (next) => { state = { ...next }; } };
}

const sentAt = new Date('2026-07-16T02:00:00.000Z');
const initial = {
  id: 'candidate-manual-outbound-1',
  botPaused: false,
  botPausedAt: null,
  botPausedBy: null,
  botPauseReason: null,
  botResumeMode: 'resumed_by_candidate_inbound',
  lastOutboundAt: new Date('2026-07-16T01:00:00.000Z'),
  reminderScheduledFor: new Date('2026-07-16T03:00:00.000Z'),
  reminderState: 'SCHEDULED'
};
const expected = {
  botPaused: initial.botPaused,
  botPausedAt: initial.botPausedAt,
  botPausedBy: initial.botPausedBy,
  botPauseReason: initial.botPauseReason,
  botResumeMode: initial.botResumeMode,
  lastOutboundAt: initial.lastOutboundAt
};

test('registra el estado posterior al envío manual solo sobre el snapshot exacto', async () => {
  const harness = createHarness(initial);
  const result = await recordManualOutboundDelivery(harness.client, {
    candidateId: initial.id,
    expected,
    actor: 'reclutador-loginpro',
    reason: 'Conversación tomada manualmente',
    sentAt
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.botPaused, true);
  assert.equal(result.candidate.botPausedBy, 'reclutador-loginpro');
  assert.equal(result.candidate.botPauseReason, 'Conversación tomada manualmente');
  assert.equal(result.candidate.botResumeMode, 'manual_resume_dashboard');
  assert.equal(result.candidate.lastOutboundAt.getTime(), sentAt.getTime());
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, 'CANCELLED');
  assert.deepEqual(harness.calls.updateMany[0].where, { id: initial.id, ...expected });
  assert.equal(harness.calls.transactions, 0);
});

test('no sobrescribe una pausa o salida más reciente', async () => {
  const harness = createHarness(initial);
  harness.setState({
    ...initial,
    botPaused: true,
    botPausedAt: new Date('2026-07-16T01:30:00.000Z'),
    botPausedBy: 'otro-admin',
    botPauseReason: 'Intervención concurrente',
    lastOutboundAt: new Date('2026-07-16T02:01:00.000Z')
  });

  const result = await recordManualOutboundDelivery(harness.client, {
    candidateId: initial.id,
    expected,
    actor: 'reclutador-loginpro',
    sentAt
  });

  assert.equal(result.count, 0);
  assert.equal(result.candidate.botPausedBy, 'otro-admin');
  assert.equal(result.candidate.lastOutboundAt.getTime(), new Date('2026-07-16T02:01:00.000Z').getTime());
});

test('rechaza cliente, snapshot, actor y fecha inválidos', async () => {
  await assert.rejects(() => recordManualOutboundDelivery(null, {}), /candidate_state_client_required/);
  const harness = createHarness(initial);
  await assert.rejects(() => recordManualOutboundDelivery(harness.client, {
    candidateId: initial.id, expected: {}, actor: 'admin'
  }), /candidate_expected_pause_snapshot_required/);
  await assert.rejects(() => recordManualOutboundDelivery(harness.client, {
    candidateId: initial.id, expected, actor: ' '
  }), /candidate_manual_outbound_actor_required/);
  await assert.rejects(() => recordManualOutboundDelivery(harness.client, {
    candidateId: initial.id, expected, actor: 'admin', sentAt: null
  }), /candidate_manual_outbound_sent_at_invalid/);
});
