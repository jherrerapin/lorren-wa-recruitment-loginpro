import fs from 'node:fs';

const webhookPath = 'src/routes/webhook.js';
const inventoryPath = 'config/transitional-code-inventory.json';
const docsPath = 'docs/architecture/transitional-code-inventory.md';
const testPath = 'test/webhookRequiredFieldAliasRemoval.test.js';

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`No se encontró ${label}.`);
  if (source.indexOf(before, first + before.length) !== -1) throw new Error(`Se encontró más de una vez ${label}.`);
  return source.replace(before, after);
}

let webhook = fs.readFileSync(webhookPath, 'utf8');
const aliasDefinition = `function getRequiredFieldKeys(vacancy = null) {\n  return getRequiredCandidateFieldKeys(vacancy);\n}\n`;
webhook = replaceExactlyOnce(webhook, aliasDefinition, '', 'la definición de getRequiredFieldKeys');

const consumerCount = (webhook.match(/\bgetRequiredFieldKeys\(/g) || []).length;
if (consumerCount < 1) throw new Error('No se encontraron consumidores de getRequiredFieldKeys.');
webhook = webhook.replace(/\bgetRequiredFieldKeys\(/g, 'getRequiredCandidateFieldKeys(');

if (/\bgetRequiredFieldKeys\b/.test(webhook)) throw new Error('Quedó una referencia a getRequiredFieldKeys en webhook.js.');
if ((webhook.match(/\bgetRequiredCandidateFieldKeys\(/g) || []).length < consumerCount) {
  throw new Error('No se reemplazaron todos los consumidores por la autoridad canónica.');
}
fs.writeFileSync(webhookPath, webhook);

const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
inventory.rules.trackedAliasSymbols = inventory.rules.trackedAliasSymbols.filter((symbol) => symbol !== 'getRequiredFieldKeys');
inventory.aliases = inventory.aliases.filter((entry) => entry.symbol !== 'getRequiredFieldKeys');
if (inventory.rules.trackedAliasSymbols.includes('getRequiredFieldKeys')) throw new Error('El símbolo sigue rastreado.');
if (inventory.aliases.some((entry) => entry.symbol === 'getRequiredFieldKeys' || entry.targetSymbol === 'getRequiredFieldKeys')) {
  throw new Error('El alias sigue inventariado o referenciado como target.');
}
fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

let docs = fs.readFileSync(docsPath, 'utf8');
docs = replaceExactlyOnce(
  docs,
  `Los aliases transitorios que permanecen en \`src/routes/webhook.js\` son:\n\n- \`getRequiredFieldKeys()\`;\n- \`formatFieldList()\`;\n- \`buildDataRequestPrompt()\`.`,
  `Los aliases transitorios que permanecen en \`src/routes/webhook.js\` son:\n\n- \`formatFieldList()\`;\n- \`buildDataRequestPrompt()\`.`,
  'la lista vigente de aliases'
);
docs = replaceExactlyOnce(
  docs,
  `## Retiros completados\n\n### Cadena \`getMissingFields()\` / \`getMissingFieldsForVacancy()\` — #656`,
  `## Retiros completados\n\n### \`getRequiredFieldKeys()\` — #658\n\nEl alias se retiró porque solo reenviaba la vacante a \`getRequiredCandidateFieldKeys()\`. Todos sus consumidores usan ahora directamente la autoridad de campos requeridos definida en \`readinessGuard.js\`.\n\nNo cambian los campos exigidos, su orden ni la configuración dinámica por vacante; se elimina únicamente un nombre intermedio.\n\n### Cadena \`getMissingFields()\` / \`getMissingFieldsForVacancy()\` — #656`,
  'la sección de retiros completados'
);
docs = replaceExactlyOnce(
  docs,
  `3. Retirar los aliases puros restantes en PR pequeños: \`getRequiredFieldKeys()\`, \`formatFieldList()\` y \`buildDataRequestPrompt()\`.`,
  `3. Retirar los aliases puros restantes en PR pequeños: \`formatFieldList()\` y \`buildDataRequestPrompt()\`.`,
  'el orden de limpieza'
);
fs.writeFileSync(docsPath, docs);

const testSource = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n\nconst webhook = fs.readFileSync('src/routes/webhook.js', 'utf8');\nconst inventory = JSON.parse(fs.readFileSync('config/transitional-code-inventory.json', 'utf8'));\n\ntest('el webhook usa directamente la autoridad canónica de campos requeridos', () => {\n  assert.doesNotMatch(webhook, /\\bgetRequiredFieldKeys\\b/);\n  assert.match(webhook, /getRequiredCandidateFieldKeys\\(vacancy\\)/);\n  assert.ok((webhook.match(/\\bgetRequiredCandidateFieldKeys\\(/g) || []).length >= 2);\n});\n\ntest('el inventario no conserva el alias retirado', () => {\n  assert.equal(inventory.rules.trackedAliasSymbols.includes('getRequiredFieldKeys'), false);\n  assert.equal(inventory.aliases.some((entry) => entry.symbol === 'getRequiredFieldKeys'), false);\n  assert.equal(inventory.aliases.some((entry) => entry.targetSymbol === 'getRequiredFieldKeys'), false);\n});\n\ntest('los aliases fuera de alcance permanecen inventariados', () => {\n  for (const symbol of ['formatFieldList', 'buildDataRequestPrompt']) {\n    assert.ok(inventory.rules.trackedAliasSymbols.includes(symbol));\n    assert.ok(inventory.aliases.some((entry) => entry.symbol === symbol));\n  }\n});\n`;
fs.writeFileSync(testPath, testSource);

console.log(JSON.stringify({ consumerCount, retired: 'getRequiredFieldKeys' }));
