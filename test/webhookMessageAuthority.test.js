import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDirection, MessageType } from '@prisma/client';
import {
  recordIntentionalSilence,
  saveOutboundMessage
} from '../src/routes/webhook.js';

function createPrismaMock({ outboundError = null } = {}) {
  const calls = [];
  const prisma = {
    message: {
      async create({ data }) {
        calls.push({ operation: 'message.create', data });
        if (outboundError) throw outboundError;
        return { id: 'message-test-1', ...data };
      }
    },
    candidate: {
      async update(args) {
        calls.push({ operation: 'candidate.update', args });
        return { id: args.where.id, ...args.data };
      }
    }
  };
  return { prisma, calls };
}

test('salida común persiste mediante el contrato saliente y luego actualiza lastOutboundAt', async () => {
  const { prisma, calls } = createPrismaMock();
  const rawPayload = { source: 'contextual_reply', model: 'test-model' };

  await saveOutboundMessage(prisma, 'candidate-test-1', 'Respuesta segura', rawPayload);

  assert.deepEqual(calls.map((call) => call.operation), [
    'message.create',
    'candidate.update'
  ]);
  assert.deepEqual(calls[0].data, {
    candidateId: 'candidate-test-1',
    direction: MessageDirection.OUTBOUND,
    messageType: MessageType.TEXT,
    body: 'Respuesta segura',
    rawPayload: {
      body: 'Respuesta segura',
      source: 'contextual_reply',
      model: 'test-model'
    }
  });
  assert.equal(calls[1].args.where.id, 'candidate-test-1');
  assert.ok(calls[1].args.data.lastOutboundAt instanceof Date);
});

test('silencio intencional persiste una salida interna sin tocar el candidato', async () => {
  const { prisma, calls } = createPrismaMock();
  const originalInfo = console.info;
  console.info = () => {};

  try {
    await recordIntentionalSilence(
      prisma,
      { id: 'candidate-test-2', currentStep: 'MENU', vacancyId: 'vacancy-test-1' },
      'mensaje recibido',
      { reason: 'guard_blocked', gate: 'consent_gate', action: 'silent' }
    );
  } finally {
    console.info = originalInfo;
  }

  assert.deepEqual(calls.map((call) => call.operation), ['message.create']);
  const data = calls[0].data;
  assert.equal(data.candidateId, 'candidate-test-2');
  assert.equal(data.direction, MessageDirection.OUTBOUND);
  assert.equal(data.messageType, MessageType.TEXT);
  assert.equal(data.body, '[silencio intencional] guard_blocked');
  assert.equal(data.rawPayload.source, 'bot_silence_trace');
  assert.equal(data.rawPayload.visibility, 'internal');
  assert.equal(data.rawPayload.neverSendToCandidate, true);
  assert.equal(data.rawPayload.inboundPreview, 'mensaje recibido');
  assert.equal(data.rawPayload.gate, 'consent_gate');
});

test('silencio intencional conserva manejo tolerante cuando falla la persistencia', async () => {
  const { prisma } = createPrismaMock({ outboundError: new Error('database unavailable') });
  const warnings = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (...args) => warnings.push(args);
  console.info = () => {};

  try {
    await assert.doesNotReject(() => recordIntentionalSilence(
      prisma,
      { id: 'candidate-test-3', currentStep: 'MENU' },
      'hola',
      { reason: 'intentional_silence' }
    ));
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], '[BOT_SILENCE_TRACE_ERROR]');
});
