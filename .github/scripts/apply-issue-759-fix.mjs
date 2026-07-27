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
let runner = fs.readFileSync(runnerPath, 'utf8');
runner = replaceOnce(
  runner,
  `    assertExpectations: false,
    openAiCalls: []`,
  `    assertExpectations: false,
    openAiCalls: [],
    recognizeCurrentEnginePrompt: true`,
  'activación exclusiva en runner de paridad'
);
fs.writeFileSync(runnerPath, runner);

console.log('Reconocimiento del prompt actual aislado en la matriz.');
