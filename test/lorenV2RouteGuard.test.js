import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const campaignSource = readFileSync(new URL('../src/routes/lorenV2.js', import.meta.url), 'utf8');
const referralsSource = readFileSync(new URL('../src/routes/lorenV2Referrals.js', import.meta.url), 'utf8');

test('rutas GET de Loren V2 usan middleware que responde o avanza', () => {
  assert.doesNotMatch(campaignSource, /router\.get\([^\n]+canSeeLorenV2/);
  assert.doesNotMatch(referralsSource, /router\.get\([^\n]+canSeeLorenV2/);
  assert.match(campaignSource, /router\.get\('\/', requireLorenV2,/);
  assert.match(referralsSource, /router\.get\('\/', requireLorenV2,/);
});
