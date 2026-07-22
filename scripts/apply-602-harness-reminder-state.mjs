import { readFileSync, writeFileSync } from 'node:fs';

const file = 'test/fixtures/conversationCases.js';
let source = readFileSync(file, 'utf8');

const prismaImport = "import { ReminderState } from '@prisma/client';";
if (!source.includes(prismaImport)) {
  const anchor = "import { buildFutureSlot } from '../helpers/mockScheduler.js';";
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`fixture import anchor count: ${count}`);
  source = source.replace(anchor, `${prismaImport}\n${anchor}`);
}

const legacy = "    reminderState: 'PENDING',";
const canonical = '    reminderState: ReminderState.NONE,';
if (!source.includes(canonical)) {
  const count = source.split(legacy).length - 1;
  if (count !== 1) throw new Error(`legacy reminderState count: ${count}`);
  source = source.replace(legacy, canonical);
}

writeFileSync(file, source, 'utf8');
console.log('Fixture reminder state corrected for #602.');
