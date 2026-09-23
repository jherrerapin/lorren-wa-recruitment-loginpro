import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MessageDirection, MessageType } from '@prisma/client';
import {
  recordIntentionalSilence,
  saveOutboundMessage
} from '../src/routes/webhook.js';
import { buildConversationTurnInput } from '../src/core/middlewares/buildConversationTurnInput.js';

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

function createShadowLogger() {
  const entries = [];
  return {
    entries,
    debug(data, message) {
      entries.push({ level: 'debug', data, message });
    },
    error(data, message) {
      entries.push({ level: 'error', data, message });
    }
  };
}

async function runConversationTurnShadow(body) {
  const logger = createShadowLogger();
  const middleware = buildConversationTurnInput({ logger });
  const req = { body };
  let nextCalls = 0;

  await middleware(req, {}, () => {
    nextCalls += 1;
  });

  return { logger, nextCalls, req };
}

test('shadowing mapea texto Meta real sin cambiar rawText ni registrar PII', async () => {
  const rawText = '  Hola, Lórren  ';
  const body = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'test-business-id',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          messages: [{
            from: 'test-user-id',
            id: 'wamid.test-message-id',
            timestamp: '1750000000',
            type: 'text',
            text: { body: rawText }
          }]
        }
      }]
    }]
  };

  const { logger, nextCalls, req } = await runConversationTurnShadow(body);

  assert.equal(nextCalls, 1);
  assert.equal(req.conversationTurnInput.turn.rawText, rawText);
  assert.equal(req.conversationTurnInput.turn.id, 'wamid.test-message-id');
  assert.deepEqual(Object.keys(req.conversationTurnInput), [
    'turn', 'candidate', 'history', 'pending', 'execution'
  ]);
  assert.deepEqual(Object.keys(req.conversationTurnInput.candidate), [
    'id', 'facts', 'updatedAt'
  ]);
  assert.deepEqual(req.conversationTurnInput.execution, {
    mayReply: true,
    dryRun: true
  });
  assert.equal(logger.entries[0].data.event, 'conversation_turn_input.shadow_valid');
  assert.match(logger.entries[0].data.turnRef, /^turn-[a-f0-9]{10}$/);
  assert.equal(logger.entries[0].data.turnId, undefined);
  assert.doesNotMatch(JSON.stringify(logger.entries), /Hola|test-user-id|wamid\.test-message-id/);
});

test('shadowing conserva la evidencia de respuestas rápidas template', async () => {
  const rawText = '  NO QUIERO RECIBIR MÁS  ';
  const body = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: 'test-user-id',
            id: 'wamid.quick-reply',
            timestamp: '1750000000',
            type: 'button',
            button: { text: rawText, payload: 'OPT_OUT' }
          }]
        }
      }]
    }]
  };

  const { logger, nextCalls, req } = await runConversationTurnShadow(body);

  assert.equal(nextCalls, 1);
  assert.equal(req.conversationTurnInput.turn.rawText, rawText);
  assert.equal(logger.entries[0].data.event, 'conversation_turn_input.shadow_valid');
  assert.doesNotMatch(JSON.stringify(logger.entries), /NO QUIERO|test-user-id/);
});

test('shadowing ignora callbacks Meta que no contienen mensajes', async () => {
  const { logger, nextCalls, req } = await runConversationTurnShadow({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.status' }] } }] }]
  });

  assert.equal(nextCalls, 1);
  assert.equal(req.conversationTurnInput, undefined);
  assert.deepEqual(logger.entries, []);
});

test('shadowing no mezcla el mensaje y la línea de cambios Meta distintos', async () => {
  const previousPhoneNumberId = process.env.META_PHONE_NUMBER_ID;
  process.env.META_PHONE_NUMBER_ID = 'recruitment-line';

  try {
    const { logger, nextCalls, req } = await runConversationTurnShadow({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [
          {
            value: {
              metadata: { phone_number_id: 'recruitment-line' },
              statuses: [{ id: 'wamid.status' }]
            }
          },
          {
            value: {
              metadata: { phone_number_id: 'dispatch-line' },
              messages: [{
                from: 'test-user-id',
                id: 'wamid.dispatch-later-change',
                timestamp: '1750000000',
                type: 'text',
                text: { body: 'mensaje operativo' }
              }]
            }
          }
        ]
      }]
    });

    assert.equal(nextCalls, 1);
    assert.equal(req.conversationTurnInput, undefined);
    assert.deepEqual(logger.entries, []);
  } finally {
    if (previousPhoneNumberId === undefined) delete process.env.META_PHONE_NUMBER_ID;
    else process.env.META_PHONE_NUMBER_ID = previousPhoneNumberId;
  }
});

test('shadowing está montado antes de los middlewares que consumen el turno', () => {
  const serverSource = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const shadowIndex = serverSource.indexOf("app.use('/webhook', conversationTurnInputShadow)");
  const attributionIndex = serverSource.indexOf("app.use('/webhook', campaignAttributionMiddleware(prisma))");

  assert.ok(shadowIndex >= 0);
  assert.ok(attributionIndex > shadowIndex);
});

test('shadowing ignora mensajes destinados a otra línea de WhatsApp', async () => {
  const previousPhoneNumberId = process.env.META_PHONE_NUMBER_ID;
  process.env.META_PHONE_NUMBER_ID = 'recruitment-line';

  try {
    const { logger, nextCalls, req } = await runConversationTurnShadow({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: 'dispatch-line' },
            messages: [{
              from: 'test-user-id',
              id: 'wamid.dispatch',
              timestamp: '1750000000',
              type: 'text',
              text: { body: 'mensaje operativo' }
            }]
          }
        }]
      }]
    });

    assert.equal(nextCalls, 1);
    assert.equal(req.conversationTurnInput, undefined);
    assert.deepEqual(logger.entries, []);
  } finally {
    if (previousPhoneNumberId === undefined) delete process.env.META_PHONE_NUMBER_ID;
    else process.env.META_PHONE_NUMBER_ID = previousPhoneNumberId;
  }
});

test('shadowing excluye comandos enviados por el supervisor', async () => {
  const previousSupervisorPhone = process.env.ADMIN_WHATSAPP_NUMBER;
  process.env.ADMIN_WHATSAPP_NUMBER = '573001234567';

  try {
    const { logger, nextCalls, req } = await runConversationTurnShadow({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            messages: [{
              from: '573001234567',
              id: 'wamid.supervisor',
              timestamp: '1750000000',
              type: 'text',
              text: { body: 'comando interno' }
            }]
          }
        }]
      }]
    });

    assert.equal(nextCalls, 1);
    assert.equal(req.conversationTurnInput, undefined);
    assert.deepEqual(logger.entries, []);
  } finally {
    if (previousSupervisorPhone === undefined) delete process.env.ADMIN_WHATSAPP_NUMBER;
    else process.env.ADMIN_WHATSAPP_NUMBER = previousSupervisorPhone;
  }
});

test('shadowing reporta entrada inválida y libera la ruta legacy', async () => {
  const { logger, nextCalls, req } = await runConversationTurnShadow({
    turn: {
      id: 'test-turn-id',
      receivedAt: '2026-09-22T19:00:00.000Z',
      rawText: { unexpected: true }
    }
  });

  assert.equal(nextCalls, 1);
  assert.equal(req.conversationTurnInput, undefined);
  assert.equal(logger.entries[0].data.event, 'conversation_turn_input.shadow_invalid');
  assert.ok(logger.entries[0].data.issues.fieldErrors.turn);
});

test('shadowing permanece fail-open si falla el acceso al body', async () => {
  const logger = createShadowLogger();
  const middleware = buildConversationTurnInput({ logger });
  const req = {};
  let nextCalls = 0;
  Object.defineProperty(req, 'body', {
    get() {
      throw new Error('synthetic body failure');
    }
  });

  await middleware(req, {}, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.equal(logger.entries[0].data.event, 'conversation_turn_input.shadow_error');
  assert.equal(logger.entries[0].data.error.message, 'synthetic body failure');
});
