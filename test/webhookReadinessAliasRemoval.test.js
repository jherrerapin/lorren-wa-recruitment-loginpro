import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const webhook = fs.readFileSync('src/routes/webhook.js', 'utf8');
const inventory = JSON.parse(fs.readFileSync('config/transitional-code-inventory.json', 'utf8'));

test('el webhook usa directamente la autoridad canónica de campos faltantes', () => {
  assert.doesNotMatch(webhook, /\bgetMissingFieldsForVacancy\b/);
  assert.doesNotMatch(webhook, /\bgetMissingFields\b/);
  assert.match(webhook, /getMissingFieldLabels\(candidate, vacancy\)/);
  assert.ok((webhook.match(/\bgetMissingFieldLabels\(/g) || []).length >= 5);
});

test('el inventario no conserva la cadena retirada', () => {
  const retired = new Set(['getMissingFieldsForVacancy', 'getMissingFields']);
  for (const symbol of retired) {
    assert.equal(inventory.rules.trackedAliasSymbols.includes(symbol), false);
    assert.equal(inventory.aliases.some((entry) => entry.symbol === symbol), false);
  }
});

test('los aliases fuera de alcance permanecen inventariados', () => {
  const remaining = ['getRequiredFieldKeys', 'formatFieldList', 'buildDataRequestPrompt'];
  for (const symbol of remaining) {
    assert.ok(inventory.rules.trackedAliasSymbols.includes(symbol));
    assert.ok(inventory.aliases.some((entry) => entry.symbol === symbol));
  }
});
