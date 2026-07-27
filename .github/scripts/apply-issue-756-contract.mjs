import fs from 'node:fs';
import assert from 'node:assert/strict';

const path = 'test/conversationEngineStepAuthority.test.js';
let source = fs.readFileSync(path, 'utf8');
const before = `  assert.match(webhookSource, /shouldUseEngineFieldPreview\\(candidate, cleanText, localParsedData, aiFields, sanitizerContext\\.pendingFields\\)/);`;
const after = `  assert.match(webhookSource, /shouldUseEngineFieldPreview\\(\\s*candidate,\\s*cleanText,\\s*localParsedData,\\s*aiFields,\\s*sanitizerContext\\.pendingFields\\s*\\)/);`;

if (!source.includes(after)) {
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `contrato multilinea del preview: se esperaba una coincidencia y se encontraron ${count}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

console.log('Contrato multilinea de preview actualizado.');
