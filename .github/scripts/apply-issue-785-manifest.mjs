import fs from 'node:fs';
import assert from 'node:assert/strict';

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${label}: se esperaba una coincidencia y se encontraron ${count}`);
  return source.replace(before, after);
}

const path = 'test/conversationEngineParity.test.js';
let source = fs.readFileSync(path, 'utf8');
source = replaceOnce(
  source,
  `  { key: 'cv_received', coverage: 'pending_webhook', reason: 'La recepción real de CV ocurre en la rama document del webhook.' },`,
  `  {\n    key: 'cv_received',\n    coverage: 'webhook_document',\n    engineBoundary: 'router_document_branch',\n    contractTests: ['test/cvDocumentParity.test.js']\n  },`,
  'escenario documental de CV'
);
source = replaceOnce(
  source,
  `test('el manifiesto conserva los 23 escenarios exactos del plan', () => {\n  assert.equal(SCENARIOS.length, 23);\n  assert.equal(new Set(SCENARIOS.map((item) => item.key)).size, 23);\n  const pending = SCENARIOS.filter((item) => item.coverage === 'pending_webhook');\n  assert.equal(pending.length, 1);\n  assert.equal(pending[0].key, 'cv_received');\n  assert.ok(pending[0].reason);\n});\n\ntest('duplicados y concurrencia se cubren antes del engine mediante contratos de webhook', () => {`,
  `test('el manifiesto conserva los 23 escenarios exactos del plan sin pendientes', () => {\n  assert.equal(SCENARIOS.length, 23);\n  assert.equal(new Set(SCENARIOS.map((item) => item.key)).size, 23);\n  assert.deepEqual(SCENARIOS.filter((item) => item.coverage === 'pending_webhook'), []);\n});\n\ntest('CV recibido se cubre mediante el router documental real', () => {\n  const scenario = SCENARIOS.find((item) => item.key === 'cv_received');\n  assert.equal(scenario.coverage, 'webhook_document');\n  assert.equal(scenario.engineBoundary, 'router_document_branch');\n  assert.deepEqual(scenario.contractTests, ['test/cvDocumentParity.test.js']);\n  assert.equal(Object.hasOwn(scenario, 'caseId'), false);\n});\n\ntest('duplicados y concurrencia se cubren antes del engine mediante contratos de webhook', () => {`,
  'contrato final del manifiesto'
);
fs.writeFileSync(path, source);
console.log('Manifiesto documental #785 actualizado.');
