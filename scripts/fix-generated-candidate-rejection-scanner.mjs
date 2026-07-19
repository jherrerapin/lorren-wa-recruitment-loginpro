import fs from 'node:fs';

const path = 'test/candidateProgressAuthority.test.js';
let source = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    '  assert.match(transition, /candidate.updateManys*(/);',
    '  assert.match(transition, /candidate\\.updateMany\\s*\\(/);'
  ],
  [
    '  assert.match(transition, /currentSteps*:s*ConversationStep.DONE/);',
    '  assert.match(transition, /currentStep\\s*:\\s*ConversationStep\\.DONE/);'
  ],
  [
    '  assert.match(transition, /statuss*:s*CandidateStatus.RECHAZADO/);',
    '  assert.match(transition, /status\\s*:\\s*CandidateStatus\\.RECHAZADO/);'
  ],
  [
    '  assert.match(transition, /rejectionReasons*:s*reason/);',
    '  assert.match(transition, /rejectionReason\\s*:\\s*reason/);'
  ],
  [
    '  assert.match(transition, /rejectionDetailss*:s*details/);',
    '  assert.match(transition, /rejectionDetails\\s*:\\s*details/);'
  ],
  [
    '  assert.match(transition, /reminderScheduledFors*:s*null/);',
    '  assert.match(transition, /reminderScheduledFor\\s*:\\s*null/);'
  ],
  [
    '  assert.match(transition, /reminderStates*:s*ReminderState.SKIPPED/);',
    '  assert.match(transition, /reminderState\\s*:\\s*ReminderState\\.SKIPPED/);'
  ],
  [
    '  assert.match(actSource, /requirementRejectionPendingFields.every/);',
    '  assert.match(actSource, /requirementRejectionPendingFields\\.every/);'
  ],
  [
    '  assert.match(actSource, /completeCandidateRequirementRejections*(s*prisma/);',
    '  assert.match(actSource, /completeCandidateRequirementRejection\\s*\\(\\s*prisma/);'
  ],
  [
    '  assert.match(actSource, /contract:s*[\'\"]requirement_rejection[\'\"]/);',
    '  assert.match(actSource, /contract:\\s*[\'\"]requirement_rejection[\'\"]/);'
  ]
];

for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  const index = source.indexOf(before);
  if (index === -1) throw new Error(`scanner_escape_source_not_found:${before}`);
  source = `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

fs.writeFileSync(path, source);
