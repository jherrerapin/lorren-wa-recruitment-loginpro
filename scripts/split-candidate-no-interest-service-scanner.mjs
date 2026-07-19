import fs from 'node:fs';

const path = 'test/candidateProgressAuthority.test.js';
let source = fs.readFileSync(path, 'utf8');

const before = `test('CandidateStateService implementa el cierre exacto por falta de interés', () => {
  const authority = readSource('src/services/candidateStateService.js');
  const transition = extractFunctionSource(authority, 'completeCandidateNoInterestTransition');
  assert.match(transition, /candidate\\.updateMany\\s*\\(/);
  assert.match(transition, /currentStep\\s*:\s*ConversationStep\\.DONE/);
  assert.match(transition, /reminderScheduledFor\\s*:\s*null/);
  assert.match(transition, /reminderState\\s*:\s*ReminderState\\.SKIPPED/);
  assert.doesNotMatch(transition, /status|botPaused|rejectionReason|rejectionDetails/);
});`;

const after = `test('CandidateStateService usa updateMany para el cierre por falta de interés', () => {
  const transition = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'completeCandidateNoInterestTransition');
  assert.match(transition, /candidate\\.updateMany\\s*\\(/);
});

test('CandidateStateService fija DONE en el cierre por falta de interés', () => {
  const transition = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'completeCandidateNoInterestTransition');
  assert.match(transition, /currentStep\\s*:\s*ConversationStep\\.DONE/);
});

test('CandidateStateService limpia la fecha del recordatorio por falta de interés', () => {
  const transition = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'completeCandidateNoInterestTransition');
  assert.match(transition, /reminderScheduledFor\\s*:\s*null/);
});

test('CandidateStateService marca SKIPPED por falta de interés', () => {
  const transition = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'completeCandidateNoInterestTransition');
  assert.match(transition, /reminderState\\s*:\s*ReminderState\\.SKIPPED/);
});

test('CandidateStateService no absorbe campos ajenos en falta de interés', () => {
  const transition = extractFunctionSource(readSource('src/services/candidateStateService.js'), 'completeCandidateNoInterestTransition');
  assert.doesNotMatch(transition, /status|botPaused|rejectionReason|rejectionDetails/);
});`;

const index = source.indexOf(before);
if (index === -1) throw new Error('no_interest_service_scanner_source_not_found');
if (source.indexOf(before, index + before.length) !== -1) throw new Error('no_interest_service_scanner_source_not_unique');
source = `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
fs.writeFileSync(path, source);
