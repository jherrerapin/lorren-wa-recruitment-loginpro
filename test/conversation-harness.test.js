import test from 'node:test';
import { conversationCases } from './fixtures/conversationCases.js';
import { runConversationCase } from './helpers/conversationHarness.js';

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.USE_CONVERSATION_ENGINE = 'true';
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';
process.env.LORREN_SEND_DELAY_MS = '0';

const { processText } = await import('../src/routes/webhook.js');
const { createDebugTrace } = await import('../src/services/debugTrace.js');

test('conversation harness regression cases', async (t) => {
  for (const conversationCase of conversationCases) {
    await t.test(conversationCase.id, async () => {
      await runConversationCase(conversationCase, { processText, createDebugTrace });
    });
  }
});
