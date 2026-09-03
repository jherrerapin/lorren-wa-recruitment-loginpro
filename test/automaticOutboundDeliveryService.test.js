import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDirection, MessageType } from '@prisma/client';
import {
  __automaticOutboundDeliveryInternals,
  deliverAutomaticOutboundText
} from '../src/services/automaticOutboundDeliveryService.js';

function createHarness({ failFirstSerializable = false } = {}) {
  const messages = [];
  const candidate = { id: 'candidate-test-1562', lastOutboundAt: null };
  const sends = [];
  const transactionOptions = [];
  let sequence = 0;
  let transactionTail = Promise.resolve();
  let shouldFailSerializable = failFirstSerializable;

  const client = {
    message: {
      async findMany(args = {}) {
        const since = args.where?.createdAt?.gte?.getTime?.() ?? 0;
        return messages
          .filter((message) => (
            message.candidateId === args.where?.candidateId
            && message.direction === args.where?.direction
            && message.messageType === args.where?.messageType
            && message.createdAt.getTime() >= since
          ))
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, args.take || messages.length)
          .map((message) => ({ ...message }));
      },
      async create({ data }) {
        const message = {
          id: `out-${++sequence}`,
          ...data,
          createdAt: new Date(Date.now() + sequence)
        };
        messages.push(message);
        return { ...message };
      },
      async findUnique({ where }) {
        const message = messages.find((item) => item.id === where.id);
        return message ? { ...message } : null;
      },
      async update({ where, data }) {
        const message = messages.find((item) => item.id === where.id);
        assert.ok(message, `message ${where.id} debe existir`);
        Object.assign(message, data);
        return { ...message };
      }
    },
    candidate: {
      async update({ where, data }) {
        assert.equal(where.id, candidate.id);
        Object.assign(candidate, data);
        return { ...candidate };
      }
    }
  };

  const prisma = {
    ...client,
    async $transaction(callback, options) {
      transactionOptions.push(options || null);
      const execute = async () => {
        if (shouldFailSerializable && options?.isolationLevel === 'Serializable') {
          shouldFailSerializable = false;
          const error = new Error('serialization conflict');
          error.code = 'P2034';
          throw error;
        }
        return callback(client);
      };
      const current = transactionTail.then(execute, execute);
      transactionTail = current.catch(() => undefined);
      return current;
    }
  };

  const sendText = async (to, body) => {
    sends.push({ to, body });
    return { messages: [{ id: `wa-${sends.length}` }] };
  };

  return { prisma, messages, candidate, sends, sendText, transactionOptions };
}

const SAME_ATTACHMENT_PAYLOAD = Object.freeze({
  source: 'response_policy_fallback',
  situation: 'attachment_other_doc',
  decision: 'request_missing_data'
});

function deliveryInput(body = 'Para continuar necesito confirmar restricciones médicas y medio de transporte.') {
  return {
    candidateId: 'candidate-test-1562',
    to: 'TEST-DESTINATION',
    body,
    rawPayload: SAME_ATTACHMENT_PAYLOAD
  };
}

test('dos entregas concurrentes del mismo propósito reclaman una sola salida persistente', async () => {
  const harness = createHarness();
  let releaseFirstSend;
  const firstSendGate = new Promise((resolve) => { releaseFirstSend = resolve; });
  let firstSendStarted = false;

  const sendText = async (to, body) => {
    harness.sends.push({ to, body });
    if (!firstSendStarted) {
      firstSendStarted = true;
      await firstSendGate;
    }
    return { messages: [{ id: `wa-${harness.sends.length}` }] };
  };

  const first = deliverAutomaticOutboundText(harness.prisma, deliveryInput(), { sendText });
  while (!firstSendStarted) await new Promise((resolve) => setImmediate(resolve));
  const second = deliverAutomaticOutboundText(harness.prisma, deliveryInput(), { sendText });
  const secondResult = await second;
  releaseFirstSend();
  const firstResult = await first;

  assert.equal(firstResult.sent, true);
  assert.equal(secondResult.suppressed, true);
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].rawPayload.delivery.state, 'SENT');
  assert.ok(harness.transactionOptions.some((options) => options?.isolationLevel === 'Serializable'));
});

test('un conflicto P2034 se reintenta sin duplicar autoridad de concurrencia', async () => {
  const harness = createHarness({ failFirstSerializable: true });
  const result = await deliverAutomaticOutboundText(harness.prisma, deliveryInput(), {
    sendText: harness.sendText
  });

  assert.equal(result.sent, true);
  assert.equal(harness.sends.length, 1);
  assert.equal(
    harness.transactionOptions.filter((options) => options?.isolationLevel === 'Serializable').length,
    2
  );
});

test('una salida equivalente del mismo propósito se suprime aun en fallback determinístico', async () => {
  const harness = createHarness();
  const first = await deliverAutomaticOutboundText(harness.prisma, deliveryInput(), {
    sendText: harness.sendText
  });
  const second = await deliverAutomaticOutboundText(harness.prisma, deliveryInput(
    'Para continuar necesito confirmar las restricciones médicas y el medio de transporte.'
  ), {
    sendText: harness.sendText
  });

  assert.equal(first.sent, true);
  assert.equal(second.suppressed, true);
  assert.equal(harness.sends.length, 1);
});

test('un resultado realmente distinto permite una nueva respuesta', async () => {
  const harness = createHarness();
  await deliverAutomaticOutboundText(harness.prisma, deliveryInput(), { sendText: harness.sendText });
  const changed = await deliverAutomaticOutboundText(harness.prisma, {
    ...deliveryInput('No pude procesar el archivo. Reenvía tu hoja de vida como PDF o DOCX.'),
    rawPayload: {
      source: 'response_policy_fallback',
      situation: 'attachment_unreadable',
      decision: 'attachment_unreadable'
    }
  }, { sendText: harness.sendText });

  assert.equal(changed.sent, true);
  assert.equal(harness.sends.length, 2);
});

test('un rechazo confirmado del proveedor queda FAILED y permite un reintento posterior', async () => {
  const harness = createHarness();
  const rejection = new Error('provider rejected');
  rejection.response = { status: 400 };

  await assert.rejects(
    () => deliverAutomaticOutboundText(harness.prisma, deliveryInput(), {
      sendText: async () => { throw rejection; }
    }),
    /provider rejected/
  );
  assert.equal(harness.messages[0].rawPayload.delivery.state, 'FAILED');

  const retry = await deliverAutomaticOutboundText(harness.prisma, deliveryInput(), {
    sendText: harness.sendText
  });
  assert.equal(retry.sent, true);
  assert.equal(harness.sends.length, 1);
});

test('una entrega incierta queda UNKNOWN y no se reenvía automáticamente', async () => {
  const harness = createHarness();
  const uncertain = new Error('network timeout after provider request');

  await assert.rejects(
    () => deliverAutomaticOutboundText(harness.prisma, deliveryInput(), {
      sendText: async () => { throw uncertain; }
    }),
    /network timeout/
  );
  assert.equal(harness.messages[0].rawPayload.delivery.state, 'UNKNOWN');

  const second = await deliverAutomaticOutboundText(harness.prisma, deliveryInput(), {
    sendText: harness.sendText
  });
  assert.equal(second.suppressed, true);
  assert.equal(harness.sends.length, 0);
  assert.equal(harness.messages.length, 1);
});

test('el alcance fuerte se deriva del propósito persistido, no de un lock en memoria', () => {
  const scoped = __automaticOutboundDeliveryInternals.buildDeliveryScope(SAME_ATTACHMENT_PAYLOAD);
  assert.equal(scoped.strong, true);
  assert.match(scoped.key, /attachment_other_doc/);
});

test('webhook delega el transporte automático a la autoridad de delivery', () => {
  const source = fs.readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  assert.match(source, /deliverAutomaticOutboundText/);
  assert.match(source, /await\s+deliverAutomaticOutboundText\(prisma/);
});

test('contrato del harness usa mensajes OUTBOUND TEXT persistidos', () => {
  assert.equal(MessageDirection.OUTBOUND, 'OUTBOUND');
  assert.equal(MessageType.TEXT, 'TEXT');
});
