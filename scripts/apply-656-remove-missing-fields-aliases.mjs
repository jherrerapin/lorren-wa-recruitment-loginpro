import fs from 'node:fs';

const webhookPath = 'src/routes/webhook.js';
const inventoryPath = 'config/transitional-code-inventory.json';
const docsPath = 'docs/architecture/transitional-code-inventory.md';
const testPath = 'test/webhookReadinessAliasRemoval.test.js';

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`No se encontró ${label}.`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Se encontró más de una vez ${label}.`);
  }
  return source.replace(before, after);
}

let webhook = fs.readFileSync(webhookPath, 'utf8');
const vacancyAlias = `function getMissingFieldsForVacancy(candidate, vacancy = null) {\n  return getMissingFieldLabels(candidate, vacancy);\n}\n`;
const chainAlias = `function getMissingFields(candidate, vacancy = null) {\n  return getMissingFieldsForVacancy(candidate, vacancy);\n}\n`;

webhook = replaceExactlyOnce(webhook, vacancyAlias, '', 'el alias getMissingFieldsForVacancy');
webhook = replaceExactlyOnce(webhook, chainAlias, '', 'el alias getMissingFields');

const consumerCount = (webhook.match(/\bgetMissingFields\(/g) || []).length;
if (consumerCount < 5) {
  throw new Error(`Se esperaban al menos 5 consumidores directos de getMissingFields; se encontraron ${consumerCount}.`);
}
webhook = webhook.replace(/\bgetMissingFields\(/g, 'getMissingFieldLabels(');

if (/\bgetMissingFields(?:ForVacancy)?\b/.test(webhook)) {
  throw new Error('Quedó un alias de campos faltantes en webhook.js.');
}
if (!(webhook.match(/\bgetMissingFieldLabels\(/g) || []).length) {
  throw new Error('No quedaron llamadas a la autoridad canónica getMissingFieldLabels.');
}
fs.writeFileSync(webhookPath, webhook);

const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const retiredSymbols = new Set(['getMissingFieldsForVacancy', 'getMissingFields']);
inventory.rules.trackedAliasSymbols = inventory.rules.trackedAliasSymbols.filter((symbol) => !retiredSymbols.has(symbol));
inventory.aliases = inventory.aliases.filter((entry) => !retiredSymbols.has(entry.symbol));

for (const symbol of retiredSymbols) {
  if (inventory.rules.trackedAliasSymbols.includes(symbol)) throw new Error(`El símbolo ${symbol} sigue rastreado.`);
  if (inventory.aliases.some((entry) => entry.symbol === symbol)) throw new Error(`El alias ${symbol} sigue inventariado.`);
}
fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

let docs = fs.readFileSync(docsPath, 'utf8');
docs = replaceExactlyOnce(
  docs,
  `Los aliases iniciales están concentrados en \`src/routes/webhook.js\`:\n\n- \`getRequiredFieldKeys()\`;\n- \`getMissingFieldsForVacancy()\`;\n- \`getMissingFields()\`;\n- \`formatFieldList()\`;\n- \`buildDataRequestPrompt()\`.\n\nLa mayoría solo renombran funciones de \`readinessGuard.js\`; \`getMissingFields()\` incluso crea una cadena sobre otro alias local. No se eliminan en este slice. El scanner impide que adquieran política sin reclasificación.`,
  `Los aliases transitorios que permanecen en \`src/routes/webhook.js\` son:\n\n- \`getRequiredFieldKeys()\`;\n- \`formatFieldList()\`;\n- \`buildDataRequestPrompt()\`.\n\nContinúan inventariados hasta retirarlos en PR pequeños con regresiones específicas. El scanner impide que adquieran política sin reclasificación.`,
  'el bloque vigente de aliases'
);

docs = replaceExactlyOnce(
  docs,
  `## Retiros completados\n\n### \`FF_SEMANTIC_SHORT_MEMORY\` — #651`,
  `## Retiros completados\n\n### Cadena \`getMissingFields()\` / \`getMissingFieldsForVacancy()\` — #656\n\nAmbos aliases se retiraron porque no añadían política ni transformación. Todos los consumidores del webhook invocan directamente \`getMissingFieldLabels(candidate, vacancy)\`, la autoridad existente en \`readinessGuard.js\`.\n\nEl cambio conserva las mismas etiquetas y el mismo orden de campos faltantes; únicamente elimina dos nombres intermedios y la cadena local entre ellos.\n\n### \`FF_SEMANTIC_SHORT_MEMORY\` — #651`,
  'la sección de retiros completados'
);

docs = replaceExactlyOnce(
  docs,
  `3. Retirar aliases puros en PR pequeños, empezando por la cadena \`getMissingFields()\` / \`getMissingFieldsForVacancy()\`.\n4. Consolidar extractor, política y motor conversacional en una sola interpretación y un solo plan por turno.\n5. Extraer autenticación, sesión, administración y adaptación de webhook fuera de los monolitos.\n6. Diseñar \`TenantContext\` y la migración del tenant inicial LoginPro.\n7. Introducir aislamiento de datos, archivos, campañas, jobs, cachés, sesiones y observabilidad por tenant antes de incorporar un segundo cliente.`,
  `3. Retirar los aliases puros restantes en PR pequeños: \`getRequiredFieldKeys()\`, \`formatFieldList()\` y \`buildDataRequestPrompt()\`.\n4. Consolidar extractor, política y motor conversacional en una sola interpretación y un solo plan por turno.\n5. Extraer autenticación, sesión, administración y adaptación de webhook fuera de los monolitos.\n6. Diseñar \`TenantContext\` y la migración del tenant inicial LoginPro.\n7. Introducir aislamiento de datos, archivos, campañas, jobs, cachés, sesiones y observabilidad por tenant antes de incorporar un segundo cliente.`,
  'el orden de limpieza'
);
fs.writeFileSync(docsPath, docs);

const testSource = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n\nconst webhook = fs.readFileSync('src/routes/webhook.js', 'utf8');\nconst inventory = JSON.parse(fs.readFileSync('config/transitional-code-inventory.json', 'utf8'));\n\ntest('el webhook usa directamente la autoridad canónica de campos faltantes', () => {\n  assert.doesNotMatch(webhook, /\\bgetMissingFieldsForVacancy\\b/);\n  assert.doesNotMatch(webhook, /\\bgetMissingFields\\b/);\n  assert.match(webhook, /getMissingFieldLabels\\(candidate, vacancy\\)/);\n  assert.ok((webhook.match(/\\bgetMissingFieldLabels\\(/g) || []).length >= 5);\n});\n\ntest('el inventario no conserva la cadena retirada', () => {\n  const retired = new Set(['getMissingFieldsForVacancy', 'getMissingFields']);\n  for (const symbol of retired) {\n    assert.equal(inventory.rules.trackedAliasSymbols.includes(symbol), false);\n    assert.equal(inventory.aliases.some((entry) => entry.symbol === symbol), false);\n  }\n});\n\ntest('los aliases fuera de alcance permanecen inventariados', () => {\n  const remaining = ['getRequiredFieldKeys', 'formatFieldList', 'buildDataRequestPrompt'];\n  for (const symbol of remaining) {\n    assert.ok(inventory.rules.trackedAliasSymbols.includes(symbol));\n    assert.ok(inventory.aliases.some((entry) => entry.symbol === symbol));\n  }\n});\n`;
fs.writeFileSync(testPath, testSource);

console.log(JSON.stringify({ consumerCount, retired: [...retiredSymbols] }));
