import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimManualOutboundDelivery,
  finalizeManualOutboundDelivery,
  MANUAL_OUTBOUND_SENDING_MODE,
  MANUAL_OUTBOUND_UNKNOWN_MODE,
  markManualOutboundDeliveryUnknown,
  restoreManualOutboundDelivery
} from '../src/services/candidateStateService.js';

function sameValue(left, right) {
  if (left instanceof Date || right instanceof Date) {
    if (left == null || right == null) return left === right;
    return new Date(left).getTime() === new Date(right).getTime();
  }
  return left === right;
}

function matchesExpected(value, expected) {
  if (
    expected
    && typeof expected === 'object'
    && !(expected instanceof Date)
    && Object.hasOwn(expected, 'gte')
    && Object.hasOwn(expected, 'lt')
  ) {
    if (value == null) return false;
    const valueTime = new Date(value).getTime();
    return valueTime >= new Date(expected.gte).getTime()
      && valueTime < new Date(expected.lt).getTime();
  }
  return sameValue(value, expected);
}

function matchesWhere(candidate, where = {}) {
  return Object.entries(where).every(([field, expected]) => matchesExpected(candidate?.[field], expected));
}

function createHarness(initialCandidate) {
  let state = structuredClone(initialCandidate);
  const calls = { updateMany: [], findUnique: [], transactions: 0 };
  const client = {
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        if (!state || !matchesWhere(state, args.where)) return { count: 0 };
        state = { ...state, ...structuredClone(args.data) };
        return { count: 1 };
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return state?.id === args.where.id ? structuredClone(state) : null;
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
    getState: () => structuredClone(state),
    setState: (next) => { state = structuredClone(next); }
  };
}

const startedAt = new Date('2026-07-16T01:00:00.000Z');
const sentAt = new Date('2026-07-16T01:00:02.000Z');
const previous = {
  id: 'candidate-manual-outbound-1',
  botPaused: false,
  botPausedAt: null,
  botPausedBy: null,
  botPauseReason: null,
  botResumeMode: 'resumed_by_candidate_inbound',
  reminderScheduledFor: new Date('2026-07-16T03:00:00.000Z'),
  reminderState: 'SCHEDULED',
  lastOutboundAt: new Date('2026-07-15T20:00:00.000Z')
};

function snapshot(candidate) {
  return {
    botPaused: candidate.botPaused,
    botPausedAt: candidate.botPausedAt,
    botPausedBy: candidate.botPausedBy,
    botPauseReason: candidate.botPauseReason,
    botResumeMode: candidate.botResumeMode,
    reminderScheduledFor: candidate.reminderScheduledFor,
    reminderState: candidate.reminderState,
    lastOutboundAt: candidate.lastOutboundAt
  };
}

function assertOneMillisecondFilter(filter, expectedDate) {
  assert.ok(filter && typeof filter === 'object');
  assert.equal(new Date(filter.gte).getTime(), expectedDate.getTime());
  assert.equal(new Date(filter.lt).getTime(), expectedDate.getTime() + 1);
}

test('reclama la entrega sin adelantar lastOutboundAt y cancela recordatorios', async () => {
  const harness = createHarness(previous);
  const result = await claimManualOutboundDelivery(harness.client, {
    candidateId: previous.id,
    expected: snapshot(previous),
    actor: 'devloginpro',
    reason: 'Conversacion tomada manualmente desde dashboard',
    now: startedAt
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.botPaused, true);
  assert.equal(result.candidate.botPausedAt.getTime(), startedAt.getTime());
  assert.equal(result.candidate.botPausedBy, 'devloginpro');
  assert.equal(result.candidate.botResumeMode, MANUAL_OUTBOUND_SENDING_MODE);
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, 'CANCELLED');
  assert.equal(result.candidate.lastOutboundAt.getTime(), previous.lastOutboundAt.getTime());
  assertOneMillisecondFilter(
    harness.calls.updateMany[0].where.reminderScheduledFor,
    previous.reminderScheduledFor
  );
  assertOneMillisecondFilter(
    harness.calls.updateMany[0].where.lastOutboundAt,
    previous.lastOutboundAt
  );
  assert.equal(harness.calls.updateMany[0].where.botPausedAt, null);
  assert.equal(harness.calls.transactions, 0);
});

test('bloquea una entrega en curso o incierta sin volver a escribir', async () => {
  for (const mode of [MANUAL_OUTBOUND_SENDING_MODE, MANUAL_OUTBOUND_UNKNOWN_MODE]) {
    const candidate = {
      ...previous,
      botPaused: true,
      botPausedAt: startedAt,
      botPausedBy: 'devloginpro',
      botPauseReason: 'Intervencion manual',
      botResumeMode: mode,
      reminderScheduledFor: null,
      reminderState: 'CANCELLED'
    };
    const harness = createHarness(candidate);
    const result = await claimManualOutboundDelivery(harness.client, {
      candidateId: candidate.id,
      expected: snapshot(candidate),
      actor: 'devloginpro',
      reason: 'Segundo intento',
      now: new Date('2026-07-16T01:00:01.000Z')
    });

    assert.equal(result.count, 0);
    assert.equal(result.blockedReason, mode);
    assert.equal(harness.calls.updateMany.length, 0);
  }
});

test('finaliza únicamente el reclamo exacto y registra la hora real de envío', async () => {
  const claimedCandidate = {
    ...previous,
    botPaused: true,
    botPausedAt: startedAt,
    botPausedBy: 'devloginpro',
    botPauseReason: 'Intervencion manual',
    botResumeMode: MANUAL_OUTBOUND_SENDING_MODE,
    reminderScheduledFor: null,
    reminderState: 'CANCELLED'
  };
  const harness = createHarness(claimedCandidate);
  const result = await finalizeManualOutboundDelivery(harness.client, {
    candidateId: claimedCandidate.id,
    expected: snapshot(claimedCandidate),
    sentAt
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.lastOutboundAt.getTime(), sentAt.getTime());
  assert.equal(result.candidate.botResumeMode, 'manual_resume_dashboard');
  assert.equal(result.candidate.botPaused, true);
  assertOneMillisecondFilter(harness.calls.updateMany[0].where.botPausedAt, startedAt);
  assertOneMillisecondFilter(
    harness.calls.updateMany[0].where.lastOutboundAt,
    previous.lastOutboundAt
  );
  assert.equal(harness.calls.updateMany[0].where.reminderScheduledFor, null);
});

test('un rechazo confirmado restaura el snapshot previo completo', async () => {
  const claimedCandidate = {
    ...previous,
    botPaused: true,
    botPausedAt: startedAt,
    botPausedBy: 'devloginpro',
    botPauseReason: 'Intervencion manual',
    botResumeMode: MANUAL_OUTBOUND_SENDING_MODE,
    reminderScheduledFor: null,
    reminderState: 'CANCELLED'
  };
  const harness = createHarness(claimedCandidate);
  const result = await restoreManualOutboundDelivery(harness.client, {
    candidateId: claimedCandidate.id,
    expected: snapshot(claimedCandidate),
    previous: snapshot(previous)
  });

  assert.equal(result.count, 1);
  assert.deepEqual(snapshot(result.candidate), snapshot(previous));
  assertOneMillisecondFilter(harness.calls.updateMany[0].where.botPausedAt, startedAt);
  assert.ok(harness.calls.updateMany[0].data.lastOutboundAt instanceof Date);
});

test('un resultado incierto conserva la pausa y exige revisión manual', async () => {
  const claimedCandidate = {
    ...previous,
    botPaused: true,
    botPausedAt: startedAt,
    botPausedBy: 'devloginpro',
    botPauseReason: 'Intervencion manual',
    botResumeMode: MANUAL_OUTBOUND_SENDING_MODE,
    reminderScheduledFor: null,
    reminderState: 'CANCELLED'
  };
  const harness = createHarness(claimedCandidate);
  const result = await markManualOutboundDeliveryUnknown(harness.client, {
    candidateId: claimedCandidate.id,
    expected: snapshot(claimedCandidate)
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.botPaused, true);
  assert.equal(result.candidate.botResumeMode, MANUAL_OUTBOUND_UNKNOWN_MODE);
  assert.equal(result.candidate.lastOutboundAt.getTime(), previous.lastOutboundAt.getTime());
});

test('rechaza snapshots incompletos y estados no reclamados', async () => {
  const harness = createHarness(previous);
  await assert.rejects(
    () => claimManualOutboundDelivery(harness.client, {
      candidateId: previous.id,
      expected: { botPaused: false },
      actor: 'dev',
      reason: 'motivo',
      now: startedAt
    }),
    /candidate_expected_reminder_state_required/
  );

  await assert.rejects(
    () => finalizeManualOutboundDelivery(harness.client, {
      candidateId: previous.id,
      expected: snapshot(previous),
      sentAt
    }),
    /candidate_manual_outbound_expected_sending_required/
  );
});
