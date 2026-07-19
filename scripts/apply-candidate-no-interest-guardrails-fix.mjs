import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index === -1) throw new Error(`${label}_source_not_found`);
  if (source.indexOf(before, index + before.length) !== -1) throw new Error(`${label}_source_not_unique`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

const path = 'test/conversationEngineGuardRails.test.js';
let source = fs.readFileSync(path, 'utf8');

source = replaceOnce(
  source,
  "import { ConversationStep, Gender } from '@prisma/client';",
  "import { ConversationStep, Gender, ReminderState } from '@prisma/client';",
  'guardrails_prisma_import'
);

source = replaceOnce(
  source,
  `    cvMimeType: 'application/pdf',
    ...overrides`,
  `    cvMimeType: 'application/pdf',
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE,
    ...overrides`,
  'guardrails_candidate_reminder_snapshot'
);

source = replaceOnce(
  source,
  `  assert.deepEqual(first.updates.at(-1).data, second.updates.at(-1).data);`,
  `  assert.deepEqual(first.stepUpdates.at(-1).data, second.stepUpdates.at(-1).data);`,
  'guardrails_order_equivalence'
);

source = replaceOnce(
  source,
  `    assert.equal(result.finalStep, ConversationStep.DONE);
    assert.equal(prisma.updates.at(-1).data.currentStep, ConversationStep.DONE);`,
  `    assert.equal(result.finalStep, ConversationStep.DONE);
    assert.equal(result.stepTransition.contract, 'no_interest');
    assert.equal(prisma.stepUpdates.at(-1).data.currentStep, ConversationStep.DONE);`,
  'guardrails_no_interest_booking'
);

source = replaceOnce(
  source,
  `    assert.equal(prisma.updates[0].data.medicalRestrictions, 'Sin restricciones médicas');
    assert.equal(prisma.updates.at(-1).data.currentStep, ConversationStep.DONE);`,
  `    assert.equal(prisma.updates[0].data.medicalRestrictions, 'Sin restricciones médicas');
    assert.equal(prisma.stepUpdates.at(-1).data.currentStep, ConversationStep.DONE);`,
  'guardrails_save_fields_no_interest'
);

fs.writeFileSync(path, source);
