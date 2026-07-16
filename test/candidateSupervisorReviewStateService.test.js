import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeSupervisorReviewAfterDelivery,
  MANUAL_OUTBOUND_UNKNOWN_MODE
} from '../src/services/candidateStateService.js';

function sameValue(left, right) {
  if (right && typeof right === 'object' && !(right instanceof Date)) {
    const value = left == null ? null : new Date(left).getTime();
    if (Object.hasOwn(right, 'gte') && value < new Date(right.gte).getTime()) return false;
    if (Object.hasOwn(right, 'lt') && value >= new Date(right.lt).getTime()) return false;
    return true;
  }
  if (left instanceof Date || right instanceof Date) {
    if (left == null || right == null) return left === right;
    return new Date(left).getTime() === new Date(right).getTime();
  }
  return left === right;
}

function createHarness(initialCandidate) {
  let state = initialCandidate ? { ...initialCandidate } : null;
  const calls = { updateMany: [], findUnique: [], transactions: 0 };
  const client = {
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        const matches = state && Object.entries(args.where).every(([key, value]) => sameValue(state[key], value));
        if (!matches) return { count: 0 };
        state = { ...state, ...args.data };
        return { count: 1 };
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return state?.id === args.where.id ? { ...state } : null;
      }
    },
    $transaction: async () => {
      calls.transactions += 1;
      throw new Error('nested_transaction_not_allowed');
    }
  };
  return {
    client,
    calls,
    getState: () => (state ? { ...state } : null),
    setState: (next) => { state = next ? { ...next } : null; }
  };
}

const pausedAt = new Date('2026-07-16T04:00:00.000Z');
const previousOutboundAt = new Date('2026-07-16T03:30:00.000Z');
const sentAt = new Date('2026-07-16T04:10:00.000Z');
const pausedCandidate = {
  id: 'candidate-supervisor-review-1',
  botPaused: true,
  botPausedAt: pausedAt,
  botPausedBy: 'admin-supervisor',
  botPauseReason: 'Intervención humana requerida',
  botResumeMode: 'awaiting_inbound_after_human_intervention',
  lastOutboundAt: previousOutboundAt
};
const expected = {
  botPaused: pausedCandidate.botPaused,
  botPausedAt: pausedCandidate.botPausedAt,
  botPausedBy: pausedCandidate.botPausedBy,
  botPauseReason: pausedCandidate.botPauseReason,
  botResumeMode: pausedCandidate.botResumeMode,
  lastOutboundAt: pausedCandidate.lastOutboundAt
};

test('completa la revisión del supervisor únicamente sobre el snapshot exacto', async () => {
  const harness = createHarness(pausedCandidate);

  const result = await completeSupervisorReviewAfterDelivery(harness.client, {
    candidateId: pausedCandidate.id,
    expected,
    sentAt
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.botPaused, false);
  assert.equal(result.candidate.botPausedAt, null);
  assert.equal(result.candidate.botPausedBy, null);
  assert.equal(result.candidate.botPauseReason, null);
  assert.equal(result.candidate.botResumeMode, null);
  assert.equal(result.candidate.lastOutboundAt.getTime(), sentAt.getTime());
  assert.equal(harness.calls.updateMany.length, 1);
  assert.deepEqual(harness.calls.updateMany[0].where.botPausedAt, {
    gte: pausedAt,
    lt: new Date(pausedAt.getTime() + 1)
  });
  assert.deepEqual(harness.calls.updateMany[0].where.lastOutboundAt, {
    gte: previousOutboundAt,
    lt: new Date(previousOutboundAt.getTime() + 1)
  });
  assert.equal(harness.calls.transactions, 0);
});

test('no limpia una pausa ni retrocede una salida concurrente', async () => {
  const harness = createHarness(pausedCandidate);
  const concurrentOutboundAt = new Date('2026-07-16T04:11:00.000Z');
  harness.setState({
    ...pausedCandidate,
    botPausedAt: new Date('2026-07-16T04:09:00.000Z'),
    botPausedBy: 'otro-admin',
    botPauseReason: 'Nueva intervención concurrente',
    botResumeMode: 'manual_resume_dashboard',
    lastOutboundAt: concurrentOutboundAt
  });

  const result = await completeSupervisorReviewAfterDelivery(harness.client, {
    candidateId: pausedCandidate.id,
    expected,
    sentAt
  });

  assert.equal(result.count, 0);
  assert.equal(result.candidate.botPaused, true);
  assert.equal(result.candidate.botPausedBy, 'otro-admin');
  assert.equal(result.candidate.botPauseReason, 'Nueva intervención concurrente');
  assert.equal(result.candidate.lastOutboundAt.getTime(), concurrentOutboundAt.getTime());
  assert.equal(harness.getState().botPaused, true);
  assert.equal(harness.calls.transactions, 0);
});

test('no levanta un estado de entrega manual incierta', async () => {
  const blockedCandidate = {
    ...pausedCandidate,
    botResumeMode: MANUAL_OUTBOUND_UNKNOWN_MODE
  };
  const harness = createHarness(blockedCandidate);

  const result = await completeSupervisorReviewAfterDelivery(harness.client, {
    candidateId: blockedCandidate.id,
    expected: {
      ...expected,
      botResumeMode: MANUAL_OUTBOUND_UNKNOWN_MODE
    },
    sentAt
  });

  assert.equal(result.count, 0);
  assert.equal(result.blockedReason, MANUAL_OUTBOUND_UNKNOWN_MODE);
  assert.equal(result.candidate.botPaused, true);
  assert.equal(harness.calls.updateMany.length, 0);
  assert.equal(harness.calls.transactions, 0);
});

test('rechaza cliente, snapshot y fechas inválidos', async () => {
  await assert.rejects(
    () => completeSupervisorReviewAfterDelivery(null, {}),
    /candidate_state_client_required/
  );
  const harness = createHarness(pausedCandidate);
  await assert.rejects(
    () => completeSupervisorReviewAfterDelivery(harness.client, {
      candidateId: pausedCandidate.id,
      expected: { ...expected, botPaused: false },
      sentAt
    }),
    /candidate_expected_paused_state_required/
  );
  await assert.rejects(
    () => completeSupervisorReviewAfterDelivery(harness.client, {
      candidateId: pausedCandidate.id,
      expected,
      sentAt: null
    }),
    /candidate_supervisor_review_sent_at_invalid/
  );
  await assert.rejects(
    () => completeSupervisorReviewAfterDelivery(harness.client, {
      candidateId: pausedCandidate.id,
      expected: { ...expected, lastOutboundAt: false },
      sentAt
    }),
    /candidate_expected_last_outbound_at_invalid/
  );
});
