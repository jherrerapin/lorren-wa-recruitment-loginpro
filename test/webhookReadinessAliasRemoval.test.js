import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const webhook = fs.readFileSync('src/routes/webhook.js', 'utf8');
const inventory = JSON.parse(fs.readFileSync('config/transitional-code-inventory.json', 'utf8'));
const retiredAliases = new Set([
  'getMissingFieldsForVacancy',
  'getMissingFields',
  'getRequiredFieldKeys',
  'formatFieldList',
  'buildDataRequestPrompt'
]);

test('el webhook usa directamente las autoridades canónicas retiradas de los aliases', () => {
  for (const symbol of retiredAliases) {
    assert.doesNotMatch(webhook, new RegExp('\\b' + symbol + '\\b'));
  }
  assert.ok((webhook.match(/\bgetMissingFieldLabels\(/g) || []).length >= 5);
  assert.ok((webhook.match(/\bgetRequiredCandidateFieldKeys\(/g) || []).length >= 5);
  assert.ok((webhook.match(/\bformatFieldListForVacancy\(/g) || []).length >= 2);
  assert.ok((webhook.match(/\bbuildCandidateDataCollectionMessage\(/g) || []).length >= 2);
});

test('el inventario no conserva aliases retirados ni referencias hacia ellos', () => {
  for (const symbol of retiredAliases) {
    assert.equal(inventory.rules.trackedAliasSymbols.includes(symbol), false);
    assert.equal(inventory.aliases.some((entry) => entry.symbol === symbol), false);
    assert.equal(inventory.aliases.some((entry) => entry.targetSymbol === symbol), false);
  }
});

test('no quedan aliases puros inventariados', () => {
  assert.deepEqual(inventory.rules.trackedAliasSymbols, []);
  assert.deepEqual(inventory.aliases, []);
});
