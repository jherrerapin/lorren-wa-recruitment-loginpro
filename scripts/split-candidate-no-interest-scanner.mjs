import fs from 'node:fs';

const path = 'test/candidateProgressAuthority.test.js';
let source = fs.readFileSync(path, 'utf8');

const before = `test('CandidateStateService controla el cierre exacto por falta de interés', () => {
  assert.equal(manifest.compositeContracts.length, 1);
  const contract = manifest.compositeContracts[0];
  assert.equal(contract.id, 'conversation_engine_no_interest');
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/conversationEngine.js');
  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, ['currentStep', 'reminderScheduledFor', 'reminderState']);
  assert.ok(contract.excludedCombinations.includes('mark_rejected'));
  assert.ok(contract.excludedCombinations.includes('pause_bot'));

  const authority = readSource('src/services/candidateStateService.js');
  const transition = extractFunctionSource(authority, 'completeCandidateNoInterestTransition');
  assert.match(transition, /candidate\\.updateMany\\s*\\(/);
  assert.match(transition, /currentStep\\s*:\s*ConversationStep\\.DONE/);
  assert.match(transition, /reminderScheduledFor\\s*:\s*null/);
  assert.match(transition, /reminderState\\s*:\s*ReminderState\\.SKIPPED/);
  assert.doesNotMatch(transition, /status|botPaused|rejectionReason|rejectionDetails/);

  const engine = readSource('src/services/conversationEngine.js');
  const actSource = extractFunctionSource(engine, 'act');
  assert.match(actSource, /hasNoInterestTransition/);
  assert.match(actSource, /noInterestUpdateFields\\.every/);
  assert.match(actSource, /completeCandidateNoInterestTransition\\s*\\(\\s*prisma/);
  assert.match(actSource, /contract:\s*['"]no_interest['"]/);
});`;

const after = `test('el manifiesto registra el contrato compuesto de falta de interés', () => {
  assert.equal(manifest.compositeContracts.length, 1);
  const contract = manifest.compositeContracts[0];
  assert.equal(contract.id, 'conversation_engine_no_interest');
  assert.equal(contract.owner, 'src/services/candidateStateService.js');
  assert.equal(contract.consumer, 'src/services/conversationEngine.js');
  assert.equal(contract.responseConsumer, 'src/services/chatEngine.js');
  assert.equal(contract.status, 'canonical');
  assert.deepEqual(contract.allowedFields, ['currentStep', 'reminderScheduledFor', 'reminderState']);
  assert.ok(contract.excludedCombinations.includes('mark_rejected'));
  assert.ok(contract.excludedCombinations.includes('pause_bot'));
});

test('CandidateStateService implementa el cierre exacto por falta de interés', () => {
  const authority = readSource('src/services/candidateStateService.js');
  const transition = extractFunctionSource(authority, 'completeCandidateNoInterestTransition');
  assert.match(transition, /candidate\\.updateMany\\s*\\(/);
  assert.match(transition, /currentStep\\s*:\s*ConversationStep\\.DONE/);
  assert.match(transition, /reminderScheduledFor\\s*:\s*null/);
  assert.match(transition, /reminderState\\s*:\s*ReminderState\\.SKIPPED/);
  assert.doesNotMatch(transition, /status|botPaused|rejectionReason|rejectionDetails/);
});

test('conversationEngine delega el cierre exacto por falta de interés', () => {
  const engine = readSource('src/services/conversationEngine.js');
  const actSource = extractFunctionSource(engine, 'act');
  assert.match(actSource, /hasNoInterestTransition/);
  assert.match(actSource, /noInterestUpdateFields\\.every/);
  assert.match(actSource, /completeCandidateNoInterestTransition\\s*\\(\\s*prisma/);
  assert.match(actSource, /contract:\s*['"]no_interest['"]/);
});`;

const index = source.indexOf(before);
if (index === -1) throw new Error('no_interest_scanner_source_not_found');
if (source.indexOf(before, index + before.length) !== -1) throw new Error('no_interest_scanner_source_not_unique');
source = `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
fs.writeFileSync(path, source);
