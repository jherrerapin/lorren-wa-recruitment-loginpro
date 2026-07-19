import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index === -1) throw new Error(`${label}_source_not_found`);
  if (source.indexOf(before, index + before.length) !== -1) throw new Error(`${label}_source_not_unique`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

{
  const path = 'src/services/candidateStateService.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    `function normalizeNoInterestSnapshot(expected = {}) {
  if (!Object.hasOwn(expected, 'reminderScheduledFor')) {
    throw new TypeError('candidate_no_interest_reminder_scheduled_for_required');
  }`,
    `function normalizeNoInterestSnapshot(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new TypeError('candidate_no_interest_reminder_scheduled_for_required');
  }
  if (!Object.hasOwn(expected, 'reminderScheduledFor')) {
    throw new TypeError('candidate_no_interest_reminder_scheduled_for_required');
  }`,
    'no_interest_snapshot_validation'
  );
  fs.writeFileSync(path, source);
}

{
  const path = 'test/candidateNoInterestStateService.test.js';
  let source = fs.readFileSync(path, 'utf8');
  source = replaceOnce(
    source,
    `    [{}, valid, /candidate_state_client_required/],
    [createClient(snapshot), { ...valid, candidateId: '' }, /candidate_id_required/],`,
    `    [{}, valid, /candidate_state_client_required/],
    [createClient(snapshot), { ...valid, expected: null }, /candidate_no_interest_reminder_scheduled_for_required/],
    [createClient(snapshot), { ...valid, expected: [] }, /candidate_no_interest_reminder_scheduled_for_required/],
    [createClient(snapshot), { ...valid, expected: 'invalid' }, /candidate_no_interest_reminder_scheduled_for_required/],
    [createClient(snapshot), { ...valid, candidateId: '' }, /candidate_id_required/],`,
    'no_interest_snapshot_regressions'
  );
  fs.writeFileSync(path, source);
}
