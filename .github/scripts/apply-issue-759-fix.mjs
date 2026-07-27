import fs from 'node:fs';
import assert from 'node:assert/strict';

const path = 'test/helpers/mockOpenAI.js';
let source = fs.readFileSync(path, 'utf8');
const before = `      const requestType = /Eres un reclutador humano experto leyendo mensajes de WhatsApp/.test(systemPrompt)
        ? 'extraction'
        : (/Sos un reclutador del equipo de seleccion de LoginPro/.test(systemPrompt) && /Devuelve SOLO un objeto JSON/.test(systemPrompt)
          ? 'conversation_engine'
          : 'natural_reply');`;
const after = `      const requestType = /Eres un reclutador humano experto leyendo mensajes de WhatsApp/.test(systemPrompt)
        ? 'extraction'
        : (/ESTADO CURADO DEL CANDIDATO \(JSON\):/.test(systemPrompt)
          && /Devuelve SOLO un objeto JSON con este formato:/.test(systemPrompt)
          && /"actions"/.test(systemPrompt)
          && /"extractedFields"/.test(systemPrompt)
          ? 'conversation_engine'
          : 'natural_reply');`;

if (!source.includes(after)) {
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `detector del prompt actual: se esperaba una coincidencia y se encontraron ${count}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

console.log('Detector del prompt actual corregido.');
