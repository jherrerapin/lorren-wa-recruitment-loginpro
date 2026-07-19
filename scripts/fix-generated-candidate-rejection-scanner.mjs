import fs from 'node:fs';

const path = 'test/candidateProgressAuthority.test.js';
let source = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    '  assert.match(transition, /candidate.updateManys*(/);',
    String.raw`  assert.match(transition, /candidate\.updateMany\s*\(/);`
  ],
  [
    '  assert.match(transition, /currentSteps*:s*ConversationStep.DONE/);',
    String.raw`  assert.match(transition, /currentStep\s*:\s*ConversationStep\.DONE/);`
  ],
  [
    '  assert.match(transition, /statuss*:s*CandidateStatus.RECHAZADO/);',
    String.raw`  assert.match(transition, /status\s*:\s*CandidateStatus\.RECHAZADO/);`
  ],
  [
    '  assert.match(transition, /rejectionReasons*:s*reason/);',
    String.raw`  assert.match(transition, /rejectionReason\s*:\s*reason/);`
  ],
  [
    '  assert.match(transition, /rejectionDetailss*:s*details/);',
    String.raw`  assert.match(transition, /rejectionDetails\s*:\s*details/);`
  ],
  [
    '  assert.match(transition, /reminderScheduledFors*:s*null/);',
    String.raw`  assert.match(transition, /reminderScheduledFor\s*:\s*null/);`
  ],
  [
    '  assert.match(transition, /reminderStates*:s*ReminderState.SKIPPED/);',
    String.raw`  assert.match(transition, /reminderState\s*:\s*ReminderState\.SKIPPED/);`
  ],
  [
    '  assert.match(actSource, /requirementRejectionPendingFields.every/);',
    String.raw`  assert.match(actSource, /requirementRejectionPendingFields\.every/);`
  ],
  [
    '  assert.match(actSource, /completeCandidateRequirementRejections*(s*prisma/);',
    String.raw`  assert.match(actSource, /completeCandidateRequirementRejection\s*\(\s*prisma/);`
  ],
  [
    '  assert.match(actSource, /contract:s*[\'\"]requirement_rejection[\'\"]/);',
    String.raw`  assert.match(actSource, /contract:\s*['"]requirement_rejection['"]/);`
  ]
];

for (const [before, after] of replacements) {
  const index = source.indexOf(before);
  if (index !== -1) {
    source = `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
    continue;
  }
  if (!source.includes(after)) {
    throw new Error(`scanner_escape_source_not_found:${before}`);
  }
}

fs.writeFileSync(path, source);

const documentationPath = 'docs/architecture/candidate-state-transition-inventory.md';
const documentation = fs.readFileSync(documentationPath, 'utf8');
fs.writeFileSync(documentationPath, `${documentation.trimEnd()}\n`);
