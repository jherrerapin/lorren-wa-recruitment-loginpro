import { readFileSync, writeFileSync } from 'node:fs';

const file = 'test/conversationalReleaseCandidatePreConsent.test.js';
let source = readFileSync(file, 'utf8');

const oldAssertion = "  assert.equal(harness.inboundRows[0].body, '[REDACTED_PRECONSENT]');\n  assert.doesNotMatch(JSON.stringify(harness.inboundRows[0].rawPayload || {}), /TEST-100000001/);";
const newAssertion = "  assert.match(harness.inboundRows[0].body || '', /no fue almacenado|no se almacenó/i);\n  assert.doesNotMatch(harness.inboundRows[0].body || '', /TEST-100000001/);\n  assert.doesNotMatch(harness.inboundRows[0].body || '', /^\\[.*\\]$/);\n  assert.doesNotMatch(JSON.stringify(harness.inboundRows[0].rawPayload || {}), /TEST-100000001/);";

const count = source.split(oldAssertion).length - 1;
if (count !== 2) {
  throw new Error(`expected two legacy preconsent assertions, found ${count}`);
}
source = source.split(oldAssertion).join(newAssertion);
writeFileSync(file, source);
