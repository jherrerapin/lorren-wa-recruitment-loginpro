import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildConversationTurnInput } from '../src/core/middlewares/buildConversationTurnInput.js';

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

test('shadowing mapea texto Meta real sin registrar PII', async () => {
  const rawText = '  Hola, Lórren  ';
  const { logger, nextCalls, req } = await runConversationTurnShadow({
    object: 'whatsapp_business_account',
    entry: [{
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
  });

  assert.equal(nextCalls, 1);
  assert.equal(req.conversationTurnInput.turn.rawText, rawText);
  assert.equal(req.conversationTurnInput.turn.id, 'wamid.test-message-id');
  assert.equal(logger.entries[0].data.event, 'conversation_turn_input.shadow_valid');
  assert.doesNotMatch(JSON.stringify(logger.entries), /Hola|test-user-id|wamid\.test-message-id/);
});

test('shadowing ignora callbacks Meta sin mensaje entrante', async () => {
  const { logger, nextCalls, req } = await runConversationTurnShadow({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.status' }] } }] }]
  });

  assert.equal(nextCalls, 1);
  assert.equal(req.conversationTurnInput, undefined);
  assert.deepEqual(logger.entries, []);
});

test('shadowing está montado antes de los middlewares que consumen el turno', () => {
  const serverSource = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const shadowIndex = serverSource.indexOf("app.use('/webhook', conversationTurnInputShadow)");
  const attributionIndex = serverSource.indexOf("app.use('/webhook', campaignAttributionMiddleware(prisma))");

  assert.ok(shadowIndex >= 0);
  assert.ok(attributionIndex > shadowIndex);
});

test('shadowing permanece fail-open ante entrada inválida', async () => {
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
});
