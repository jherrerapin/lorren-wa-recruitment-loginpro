import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDirection } from '@prisma/client';
import {
  deliverManualOutboundText,
  getManualOutboundUserMessage
} from '../src/services/manualOutboundDeliveryService.js';
import {
  MANUAL_OUTBOUND_SENDING_MODE,
  MANUAL_OUTBOUND_UNKNOWN_MODE
} from '../src/services/candidateStateService.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sameValue(left, right) {
  if (left instanceof Date || right instanceof Date) {
    if (left == null || right == null) return left === right;
    return new Date(left).getTime() === new Date(right).getTime();
  }
  return left === right;
}

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([field, expected]) => {
    const value = row?.[field];
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && Object.hasOwn(expected, 'gte')) {
      return new Date(value).getTime() >= new Date(expected.gte).getTime();
    }
    return sameValue(value, expected);
  });
}

function applySelect(row, select) {
  if (!select) return clone(row);
  const result = {};
  for (const [field, enabled] of Object.entries(select)) {
    if (enabled) result[field] = clone(row?.[field]);
  }
  return result;
}

function createHarness({ candidate: initialCandidate, messages: initialMessages = [] } = {}) {
  const state = {
    candidate: clone(initialCandidate),
    messages: clone(initialMessages)
  };
  const calls = {
    order: [],
    transactions: 0,
    sends: []
  };
  let messageSequence = state.messages.length;

  const prisma = {
    candidate: {
      findUnique: async ({ where, select } = {}) => {
        const row = state.candidate?.id === where?.id ? state.candidate : null;
        return row ? applySelect(row, select) : null;
      },
      updateMany: async ({ where, data } = {}) => {
        calls.order.push(`candidate:update:${data.botResumeMode || 'state'}`);
        if (!state.candidate || !matchesWhere(state.candidate, where)) return { count: 0 };
        Object.assign(state.candidate, clone(data));
        return { count: 1 };
      }
    },
    message: {
      findMany: async ({ where, orderBy, take, select } = {}) => {
        let rows = state.messages.filter((row) => matchesWhere(row, where));
        if (orderBy?.createdAt === 'desc') {
          rows = rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((row) => applySelect(row, select));
      },
      create: async ({ data } = {}) => {
        calls.order.push(`message:create:${data.rawPayload?.delivery?.state}`);
        const row = {
          id: `message-${++messageSequence}`,
          createdAt: new Date(data.rawPayload.delivery.startedAt),
          respondedAt: null,
          waMessageId: null,
          ...clone(data)
        };
        state.messages.push(row);
        return clone(row);
      },
      findUnique: async ({ where, select } = {}) => {
        const row = state.messages.find((message) => message.id === where?.id) || null;
        return row ? applySelect(row, select) : null;
      },
      update: async ({ where, data } = {}) => {
        const row = state.messages.find((message) => message.id === where?.id);
        if (!row) throw new Error('message_not_found');
        calls.order.push(`message:update:${data.rawPayload?.delivery?.state}`);
        Object.assign(row, clone(data));
        return clone(row);
      }
    },
    $transaction: async (callback) => {
      calls.transactions += 1;
      const snapshot = clone(state);
      try {
        return await callback(prisma);
      } catch (error) {
        state.candidate = snapshot.candidate;
        state.messages.splice(0, state.messages.length, ...snapshot.messages);
        throw error;
      }
    }
  };

  return {
    prisma,
    state,
    calls,
    sendText: async (phone, body) => {
      calls.order.push('provider:send');
      calls.sends.push({ phone, body });
      return { messages: [{ id: 'wamid.manual.1' }] };
    }
  };
}

function createClock(...values) {
  let index = 0;
  return () => {
    const selected = values[Math.min(index, values.length - 1)];
    index += 1;
    return new Date(selected);
  };
}

const baseCandidate = {
  id: 'candidate-delivery-1',
  phone: '573001112233',
  botPaused: false,
  botPausedAt: null,
  botPausedBy: null,
  botPauseReason: null,
  botResumeMode: 'resumed_by_candidate_inbound',
  reminderScheduledFor: new Date('2026-07-16T04:00:00.000Z'),
  reminderState: 'SCHEDULED',
  lastOutboundAt: new Date('2026-07-15T20:00:00.000Z')
};

const input = {
  candidateId: baseCandidate.id,
  phone: baseCandidate.phone,
  body: '  Mensaje manual exacto.  ',
  actor: 'devloginpro',
  reason: 'Conversacion tomada manualmente desde dashboard',
  rawPayload: {
    source: 'admin_outbound',
    action: 'free_text',
    preserveExactBody: true
  }
};

test('crea intención antes de Meta y finaliza mensaje y candidato al confirmar envío', async () => {
  const harness = createHarness({ candidate: baseCandidate });
  const result = await deliverManualOutboundText(harness.prisma, input, {
    sendText: harness.sendText,
    now: createClock('2026-07-16T01:00:00.000Z', '2026-07-16T01:00:02.000Z')
  });

  assert.equal(result.sent, true);
  assert.equal(result.deliveryState, 'SENT');
  assert.equal(result.providerMessageId, 'wamid.manual.1');
  assert.deepEqual(harness.calls.order.slice(0, 3), [
    `candidate:update:${MANUAL_OUTBOUND_SENDING_MODE}`,
    'message:create:SENDING',
    'provider:send'
  ]);
  assert.equal(harness.calls.sends[0].body, input.body);
  assert.equal(harness.state.messages[0].body, input.body);
  assert.equal(harness.state.messages[0].direction, MessageDirection.OUTBOUND);
  assert.equal(harness.state.messages[0].waMessageId, 'wamid.manual.1');
  assert.equal(harness.state.messages[0].rawPayload.delivery.state, 'SENT');
  assert.equal(harness.state.messages[0].rawPayload.delivery.retryPolicy, 'MANUAL_REVIEW_ONLY');
  assert.equal(harness.state.candidate.botPaused, true);
  assert.equal(harness.state.candidate.botResumeMode, 'manual_resume_dashboard');
  assert.equal(harness.state.candidate.lastOutboundAt.toISOString(), '2026-07-16T01:00:02.000Z');
});

test('un rechazo HTTP confirmado marca FAILED y restaura todo el snapshot previo', async () => {
  const harness = createHarness({ candidate: baseCandidate });
  const rejection = new Error('Bad Request');
  rejection.response = { status: 400 };

  await assert.rejects(
    () => deliverManualOutboundText(harness.prisma, input, {
      sendText: async () => {
        harness.calls.order.push('provider:send');
        throw rejection;
      },
      now: createClock('2026-07-16T01:05:00.000Z', '2026-07-16T01:05:01.000Z')
    }),
    (error) => {
      assert.equal(error.code, 'manual_outbound_provider_rejected');
      assert.match(getManualOutboundUserMessage(error), /rechazó el mensaje/i);
      return true;
    }
  );

  assert.equal(harness.state.messages[0].rawPayload.delivery.state, 'FAILED');
  assert.equal(harness.state.candidate.botPaused, baseCandidate.botPaused);
  assert.equal(harness.state.candidate.botResumeMode, baseCandidate.botResumeMode);
  assert.equal(harness.state.candidate.reminderState, baseCandidate.reminderState);
  assert.equal(
    harness.state.candidate.reminderScheduledFor.toISOString(),
    baseCandidate.reminderScheduledFor.toISOString()
  );
  assert.equal(harness.state.candidate.lastOutboundAt.toISOString(), baseCandidate.lastOutboundAt.toISOString());
});

test('un timeout queda UNKNOWN, mantiene pausa y prohíbe reintento automático', async () => {
  const harness = createHarness({ candidate: baseCandidate });
  const timeout = new Error('timeout of 15000ms exceeded');
  timeout.code = 'ECONNABORTED';

  await assert.rejects(
    () => deliverManualOutboundText(harness.prisma, input, {
      sendText: async () => {
        harness.calls.order.push('provider:send');
        throw timeout;
      },
      now: createClock('2026-07-16T01:10:00.000Z', '2026-07-16T01:10:15.000Z')
    }),
    (error) => {
      assert.equal(error.code, 'manual_outbound_provider_unknown');
      assert.match(getManualOutboundUserMessage(error), /No lo reintentes/i);
      return true;
    }
  );

  assert.equal(harness.state.messages[0].rawPayload.delivery.state, 'UNKNOWN');
  assert.equal(harness.state.messages[0].rawPayload.delivery.retryPolicy, 'MANUAL_REVIEW_ONLY');
  assert.equal(harness.state.candidate.botPaused, true);
  assert.equal(harness.state.candidate.botResumeMode, MANUAL_OUTBOUND_UNKNOWN_MODE);
  assert.equal(harness.state.candidate.lastOutboundAt.toISOString(), baseCandidate.lastOutboundAt.toISOString());
});

test('bloquea una entrega idéntica reciente después de un envío confirmado', async () => {
  const harness = createHarness({ candidate: baseCandidate });
  await deliverManualOutboundText(harness.prisma, input, {
    sendText: harness.sendText,
    now: createClock('2026-07-16T01:20:00.000Z', '2026-07-16T01:20:01.000Z')
  });

  await assert.rejects(
    () => deliverManualOutboundText(harness.prisma, input, {
      sendText: harness.sendText,
      now: createClock('2026-07-16T01:20:05.000Z')
    }),
    (error) => {
      assert.equal(error.code, 'manual_outbound_duplicate_recent');
      return true;
    }
  );

  assert.equal(harness.calls.sends.length, 1);
  assert.equal(harness.state.messages.length, 1);
});

test('bloquea una entrega ya reclamada antes de contactar al proveedor', async () => {
  const claimedCandidate = {
    ...baseCandidate,
    botPaused: true,
    botPausedAt: new Date('2026-07-16T01:30:00.000Z'),
    botPausedBy: 'otro-admin',
    botPauseReason: 'Entrega en curso',
    botResumeMode: MANUAL_OUTBOUND_SENDING_MODE,
    reminderScheduledFor: null,
    reminderState: 'CANCELLED'
  };
  const harness = createHarness({ candidate: claimedCandidate });

  await assert.rejects(
    () => deliverManualOutboundText(harness.prisma, input, {
      sendText: harness.sendText,
      now: createClock('2026-07-16T01:30:01.000Z')
    }),
    (error) => {
      assert.equal(error.code, 'manual_outbound_candidate_conflict');
      assert.match(getManualOutboundUserMessage(error), /entrega manual en curso/i);
      return true;
    }
  );

  assert.equal(harness.calls.sends.length, 0);
  assert.equal(harness.state.messages.length, 0);
});
