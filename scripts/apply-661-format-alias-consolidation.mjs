import fs from 'node:fs';

const webhookPath = 'src/routes/webhook.js';
const inventoryPath = 'config/transitional-code-inventory.json';
const docsPath = 'docs/architecture/transitional-code-inventory.md';
const consolidatedTestPath = 'test/webhookReadinessAliasRemoval.test.js';
const ciPath = '.github/workflows/ci.yml';

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`No se encontró ${label}.`);
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Se encontró más de una vez ${label}.`);
  }
  return source.replace(before, after);
}

let webhook = fs.readFileSync(webhookPath, 'utf8');
const aliasDefinition = `function formatFieldList(fields = [], vacancy = null) {\n  return formatFieldListForVacancy(fields, vacancy);\n}\n`;
webhook = replaceExactlyOnce(webhook, aliasDefinition, '', 'la definición de formatFieldList');

const consumerCount = (webhook.match(/\bformatFieldList\(/g) || []).length;
if (consumerCount !== 1) {
  throw new Error(`Se esperaba exactamente un consumidor de formatFieldList; se encontraron ${consumerCount}.`);
}
webhook = webhook.replace(/\bformatFieldList\(/g, 'formatFieldListForVacancy(');
if (/\bformatFieldList\b/.test(webhook)) throw new Error('Quedó una referencia a formatFieldList en webhook.js.');
fs.writeFileSync(webhookPath, webhook);

const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
inventory.rules.trackedAliasSymbols = inventory.rules.trackedAliasSymbols.filter((symbol) => symbol !== 'formatFieldList');
inventory.aliases = inventory.aliases.filter((entry) => entry.symbol !== 'formatFieldList');
if (inventory.rules.trackedAliasSymbols.includes('formatFieldList')) throw new Error('formatFieldList sigue rastreado.');
if (inventory.aliases.some((entry) => entry.symbol === 'formatFieldList' || entry.targetSymbol === 'formatFieldList')) {
  throw new Error('formatFieldList sigue inventariado o referenciado como target.');
}
fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

let docs = fs.readFileSync(docsPath, 'utf8');
docs = replaceExactlyOnce(
  docs,
  `Los aliases transitorios que permanecen en \`src/routes/webhook.js\` son:\n\n- \`formatFieldList()\`;\n- \`buildDataRequestPrompt()\`.`,
  `El único alias transitorio que permanece en \`src/routes/webhook.js\` es:\n\n- \`buildDataRequestPrompt()\`.`,
  'la lista vigente de aliases'
);
docs = replaceExactlyOnce(
  docs,
  `## Retiros completados\n\n### \`getRequiredFieldKeys()\` — #658`,
  `## Retiros completados\n\n### \`formatFieldList()\` — #661\n\nEl alias se retiró porque solo reenviaba los mismos argumentos a \`formatFieldListForVacancy()\` y tenía un único consumidor. El formateador real permanece sin cambios.\n\nEn el mismo slice se consolidaron las pruebas de aliases retirados y se eliminó un archivo de prueba duplicado con una expectativa obsoleta.\n\n### \`getRequiredFieldKeys()\` — #658`,
  'la sección de retiros completados'
);
docs = replaceExactlyOnce(
  docs,
  `- un alias inventariado desaparece, apunta a un target inexistente o deja de ser puro sin reclasificación.`,
  `- un alias inventariado desaparece, apunta a un target inexistente o deja de ser puro sin reclasificación;\n- un alias ya retirado reaparece en el webhook o vuelve a registrarse en el inventario.`,
  'la lista de bloqueos de CI'
);
docs = replaceExactlyOnce(
  docs,
  `3. Retirar los aliases puros restantes en PR pequeños: \`formatFieldList()\` y \`buildDataRequestPrompt()\`.`,
  `3. Retirar el último alias puro del webhook: \`buildDataRequestPrompt()\`.`,
  'el orden de limpieza'
);
fs.writeFileSync(docsPath, docs);

const consolidatedTest = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n\nconst webhook = fs.readFileSync('src/routes/webhook.js', 'utf8');\nconst inventory = JSON.parse(fs.readFileSync('config/transitional-code-inventory.json', 'utf8'));\nconst retiredAliases = new Set([\n  'getMissingFieldsForVacancy',\n  'getMissingFields',\n  'getRequiredFieldKeys',\n  'formatFieldList'\n]);\n\ntest('el webhook usa directamente las autoridades canónicas retiradas de los aliases', () => {\n  for (const symbol of retiredAliases) {\n    assert.doesNotMatch(webhook, new RegExp('\\\\b' + symbol + '\\\\b'));\n  }\n  assert.ok((webhook.match(/\\bgetMissingFieldLabels\\(/g) || []).length >= 5);\n  assert.ok((webhook.match(/\\bgetRequiredCandidateFieldKeys\\(/g) || []).length >= 5);\n  assert.ok((webhook.match(/\\bformatFieldListForVacancy\\(/g) || []).length >= 2);\n});\n\ntest('el inventario no conserva aliases retirados ni referencias hacia ellos', () => {\n  for (const symbol of retiredAliases) {\n    assert.equal(inventory.rules.trackedAliasSymbols.includes(symbol), false);\n    assert.equal(inventory.aliases.some((entry) => entry.symbol === symbol), false);\n    assert.equal(inventory.aliases.some((entry) => entry.targetSymbol === symbol), false);\n  }\n});\n\ntest('solo permanece inventariado buildDataRequestPrompt', () => {\n  assert.deepEqual(inventory.rules.trackedAliasSymbols, ['buildDataRequestPrompt']);\n  assert.deepEqual(inventory.aliases.map((entry) => entry.symbol), ['buildDataRequestPrompt']);\n});\n`;
fs.writeFileSync(consolidatedTestPath, consolidatedTest);

let ci = fs.readFileSync(ciPath, 'utf8');
ci = replaceExactlyOnce(
  ci,
  `      - name: Validate transitional code inventory\n        run: node --test test/transitionalCodeInventory.test.js`,
  `      - name: Validate transitional code and retired aliases\n        run: node --test test/transitionalCodeInventory.test.js test/webhookReadinessAliasRemoval.test.js`,
  'el gate de inventario transitorio'
);
fs.writeFileSync(ciPath, ci);

console.log(JSON.stringify({ consumerCount, retired: 'formatFieldList', remainingAlias: 'buildDataRequestPrompt' }));
