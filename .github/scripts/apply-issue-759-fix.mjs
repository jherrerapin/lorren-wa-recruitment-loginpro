import fs from 'node:fs';
import assert from 'node:assert/strict';

const path = 'test/helpers/mockOpenAI.js';
let source = fs.readFileSync(path, 'utf8');
const detectorPattern = /      const requestType = \/Eres un reclutador humano experto leyendo mensajes de WhatsApp\/\.test\(systemPrompt\)[\s\S]*?          : 'natural_reply'\);/;
const replacement = `      const requestType = /Eres un reclutador humano experto leyendo mensajes de WhatsApp/.test(systemPrompt)
        ? 'extraction'
        : (/PASO ACTUAL DEL FLUJO:/.test(systemPrompt)
          ? 'conversation_engine'
          : 'natural_reply');`;

if (!source.includes(replacement)) {
  assert.match(source, detectorPattern, 'No se encontró el detector de llamadas OpenAI generado.');
  source = source.replace(detectorPattern, replacement);
  fs.writeFileSync(path, source);
}

console.log('Detector del prompt actual corregido.');
