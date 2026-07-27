import { conversationCases } from '../fixtures/conversationCases.js';
import { buildParitySnapshot, runConversationCase } from './conversationHarness.js';

const mode = String(process.argv[2] || 'false');
const caseIds = JSON.parse(process.argv[3] || '[]');

if (Array.isArray(caseIds) && caseIds.length) {
  if (!['true', 'false'].includes(mode)) throw new Error('Modo de engine inválido.');
  process.env.NODE_ENV = 'test';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.USE_CONVERSATION_ENGINE = mode;
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
  process.env.LORREN_SEND_DELAY_MS = '0';

  const { processText } = await import('../../src/routes/webhook.js');
  const { createDebugTrace } = await import('../../src/services/debugTrace.js');
  const byId = new Map(conversationCases.map((item) => [item.id, item]));
  const snapshots = [];

  for (const caseId of caseIds) {
    const conversationCase = byId.get(caseId);
    if (!conversationCase) throw new Error(`Caso de conversación no encontrado: ${caseId}`);
    const result = await runConversationCase(conversationCase, {
      processText,
      createDebugTrace,
      assertExpectations: false,
      openAiCalls: [],
      recognizeCurrentEnginePrompt: true
    });
    snapshots.push(buildParitySnapshot({ caseId, mode, result }));
  }

  console.log('__LORREN_PARITY__' + JSON.stringify(snapshots));
}
