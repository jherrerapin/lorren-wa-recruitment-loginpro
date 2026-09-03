import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/services/dataConsentGate.js';
const source = readFileSync(path, 'utf8');
let replacements = 0;

const patched = source.replace(
  /(messageType:\s*inboundMessageType\(message\),\n)(\s+)(body:\s*consentEvidenceBody\()/g,
  (_match, prefix, indent, bodyStart) => {
    replacements += 1;
    return `${prefix}${indent}respondedAt: new Date(),\n${indent}${bodyStart}`;
  }
);

if (replacements !== 2) {
  throw new Error(`expected_2_consumed_inbound_sites_got_${replacements}`);
}
if (patched === source) throw new Error('data_consent_gate_not_changed');

writeFileSync(path, patched);
