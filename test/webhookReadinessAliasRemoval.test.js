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
const retiredReadinessInternals = new Set([
  'getMissingFieldLabels',
  'getRequiredCandidateFieldKeys',
  'formatFieldListForVacancy',
  'buildCandidateDataCollectionMessage'
]);

test('el webhook delega readiness en la autoridad canónica sin reconstruirla en HTTP', () => {
  for (const symbol of retiredAliases) {
    assert.doesNotMatch(webhook, new RegExp('\\b' + symbol + '\\b'));
  }
  for (const symbol of retiredReadinessInternals) {
    assert.doesNotMatch(webhook, new RegExp('\\b' + symbol + '\\b'));
  }

  assert.match(webhook, /\bgetCandidateReadiness\b/);
  assert.ok((webhook.match(/\bgetCandidateReadiness\(/g) || []).length >= 1);
  assert.match(webhook, /\bbuildConversationTurnInput\b/);
  assert.match(webhook, /\bcalculateConversationDecision\b/);
  assert.match(webhook, /\bexecuteConversationDecision\b/);
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
