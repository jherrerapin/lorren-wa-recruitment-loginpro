import fs from 'node:fs';
import assert from 'node:assert/strict';

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${label}: se esperaba una coincidencia y se encontraron ${count}`);
  return source.replace(before, after);
}

const mockPath = 'test/helpers/mockOpenAI.js';
let mock = fs.readFileSync(mockPath, 'utf8');
mock = replaceOnce(
  mock,
  `export function installOpenAIMock({ whatsappMock, responder, calls } = {}) {`,
  `export function installOpenAIMock({ whatsappMock, responder, calls, recognizeCurrentEnginePrompt = false } = {}) {`,
  'opción aislada del prompt vigente'
);

const blockPattern = /      const requestType = \/Eres un reclutador humano experto leyendo mensajes de WhatsApp\/\.test\(systemPrompt\)[\s\S]*?        content = buildNaturalReply\(systemPrompt\);\n      }/;
const blockReplacement = `      const extractionPrompt = /Eres un reclutador humano experto leyendo mensajes de WhatsApp/.test(systemPrompt);
      const legacyEnginePrompt = /Sos un reclutador del equipo de seleccion de LoginPro/.test(systemPrompt)
        && /Devuelve SOLO un objeto JSON/.test(systemPrompt);
      const currentEnginePrompt = /PASO ACTUAL DEL FLUJO:/.test(systemPrompt);
      const requestType = extractionPrompt
        ? 'extraction'
        : (currentEnginePrompt ? 'conversation_engine' : 'natural_reply');
      if (Array.isArray(calls)) calls.push({ type: requestType });

      let content;
      if (typeof responder === 'function') {
        content = responder({ url, payload, systemPrompt, userText });
      } else if (extractionPrompt) {
        content = buildAiParserResponse(userText);
      } else if (legacyEnginePrompt || (recognizeCurrentEnginePrompt && currentEnginePrompt)) {
        content = buildEngineDecision(systemPrompt, userText);
      } else {
        content = buildNaturalReply(systemPrompt);
      }`;
assert.match(mock, blockPattern, 'No se encontró el bloque generado del mock OpenAI.');
mock = mock.replace(blockPattern, blockReplacement);
fs.writeFileSync(mockPath, mock);

const harnessPath = 'test/helpers/conversationHarness.js';
let harness = fs.readFileSync(harnessPath, 'utf8');
harness = replaceOnce(
  harness,
  `  const restoreAxios = installOpenAIMock({ whatsappMock, calls: openAiCalls });`,
  `  const restoreAxios = installOpenAIMock({
    whatsappMock,
    calls: openAiCalls,
    recognizeCurrentEnginePrompt: Boolean(options.recognizeCurrentEnginePrompt)
  });`,
  'opción del helper compartido'
);
fs.writeFileSync(harnessPath, harness);

const runnerPath = 'test/helpers/runConversationParityCases.js';
fs.writeFileSync(runnerPath, `import { conversationCases } from '../fixtures/conversationCases.js';
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
    if (!conversationCase) throw new Error(\`Caso de conversación no encontrado: \${caseId}\`);
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
`);

console.log('Reconocimiento del prompt actual aislado y runner seguro bajo node test.');
