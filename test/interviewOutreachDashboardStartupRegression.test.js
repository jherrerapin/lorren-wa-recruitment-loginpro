import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { interviewOutreachManagementRouter } from '../src/routes/interviewOutreachManagement.js';

test('la ruta de gestión de entrevistas carga sin depender de la confirmación automática retirada', () => {
  assert.equal(typeof interviewOutreachManagementRouter, 'function');
  const router = interviewOutreachManagementRouter({});
  assert.equal(typeof router, 'function');

  const source = readFileSync(
    new URL('../src/routes/interviewOutreachManagement.js', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(source, /deriveInterviewOutreachAttendance/);
  assert.doesNotMatch(source, /vacancyDashboardSearchExpansion\.js/);
  assert.doesNotMatch(source, /direction:\s*'INBOUND'/);
  assert.match(source, /buildInterviewManagementSnapshot\(\{\s*review(?:,|\s*\})/);
});
