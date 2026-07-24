import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const webhook = fs.readFileSync('src/routes/webhook.js', 'utf8');
const inventory = JSON.parse(fs.readFileSync('config/transitional-code-inventory.json', 'utf8'));

test('el webhook usa directamente la autoridad canónica de campos requeridos', () => {
  assert.doesNotMatch(webhook, /\bgetRequiredFieldKeys\b/);
  assert.match(webhook, /getRequiredCandidateFieldKeys\(vacancy\)/);
  assert.ok((webhook.match(/\bgetRequiredCandidateFieldKeys\(/g) || []).length >= 2);
});

test('el inventario no conserva el alias retirado', () => {
  assert.equal(inventory.rules.trackedAliasSymbols.includes('getRequiredFieldKeys'), false);
  assert.equal(inventory.aliases.some((entry) => entry.symbol === 'getRequiredFieldKeys'), false);
  assert.equal(inventory.aliases.some((entry) => entry.targetSymbol === 'getRequiredFieldKeys'), false);
});

test('los aliases fuera de alcance permanecen inventariados', () => {
  for (const symbol of ['formatFieldList', 'buildDataRequestPrompt']) {
    assert.ok(inventory.rules.trackedAliasSymbols.includes(symbol));
    assert.ok(inventory.aliases.some((entry) => entry.symbol === symbol));
  }
});
