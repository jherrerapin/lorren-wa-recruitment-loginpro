import fs from 'node:fs';

const path = 'test/reminder.test.js';
const source = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const expected = `      status: 'SCHEDULED',
      reminderSentAt: new Date(REMINDER_9_00_AM_CO),
      reminderWindowClosed: true
    }],
    vacancies: [{ id: 'vac', isActive: true, schedulingEnabled: true }],
    messages: [{
      id: 'msg-reminder',
      candidateId: 'cand-no-response',`;
const replacement = `      status: 'SCHEDULED',
      reminderSentAt: new Date(REMINDER_9_00_AM_CO),
      reminderResponse: null,
      reminderWindowClosed: true
    }],
    vacancies: [{ id: 'vac', isActive: true, schedulingEnabled: true }],
    messages: [{
      id: 'msg-reminder',
      candidateId: 'cand-no-response',`;

const first = source.indexOf(expected);
const second = source.indexOf(expected, first + expected.length);
if (first < 0 || second >= 0) {
  throw new Error(`fixture_match_invalid:${first}:${second}`);
}

fs.writeFileSync(path, source.replace(expected, replacement), 'utf8');
console.log('NO_RESPONSE reminder fixture updated.');
