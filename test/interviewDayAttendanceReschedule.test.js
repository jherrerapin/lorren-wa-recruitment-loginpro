import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const uiSource = readFileSync(
  new URL('../src/public/interview-outreach-management.js', import.meta.url),
  'utf8'
);
const serviceSource = readFileSync(
  new URL('../src/services/interviewOutreachManagement.js', import.meta.url),
  'utf8'
);
const routeSource = readFileSync(
  new URL('../src/routes/interviewOutreachManagement.js', import.meta.url),
  'utf8'
);

test('Reprogramó es una acción visual de Del día y no un cuarto estado persistido de asistencia', () => {
  assert.match(uiSource, /const DAY_ATTENDANCE_OPTIONS = \[[\s\S]*\['RESCHEDULED', 'Reprogramó'\]/);
  assert.match(uiSource, /const attendanceOptions = attendanceOnly \? DAY_ATTENDANCE_OPTIONS : ATTENDANCE_OPTIONS/);

  const persistedStatuses = serviceSource.match(
    /export const INTERVIEW_ATTENDANCE_STATUSES = Object\.freeze\(\[([\s\S]*?)\]\);/
  );
  assert.ok(persistedStatuses, 'No se encontró la autoridad de estados de asistencia');
  assert.match(persistedStatuses[1], /'PENDING'/);
  assert.match(persistedStatuses[1], /'ATTENDED'/);
  assert.match(persistedStatuses[1], /'NO_SHOW'/);
  assert.doesNotMatch(persistedStatuses[1], /RESCHEDULED/);
});

test('seleccionar Reprogramó muestra nueva fecha y guarda mediante coordinación canónica', () => {
  const panelStart = uiSource.indexOf('function buildDayManagementPanel(');
  const panelEnd = uiSource.indexOf('\n  function reviewedDecision', panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart, 'No se encontró el panel de gestión');
  const panelSource = uiSource.slice(panelStart, panelEnd);

  assert.match(panelSource, /managementField\('Nueva fecha y hora', rescheduleInput\)/);
  assert.match(panelSource, /const rescheduled = attendance\.value === 'RESCHEDULED'/);
  assert.match(panelSource, /rescheduleField\.hidden = !rescheduled/);
  assert.match(panelSource, /rescheduleInput\.required = rescheduled/);
  assert.match(panelSource, /Selecciona la nueva fecha y hora de la entrevista\./);
  assert.match(
    panelSource,
    /api\(`\/candidates\/\$\{encodeURIComponent\(candidateId\)\}\/coordination`, \{[\s\S]*body: JSON\.stringify\(\{ status: 'CONFIRMED', scheduledAt \}\)/
  );
  assert.match(panelSource, /status\.textContent = 'Entrevista reprogramada\.'/);
  assert.match(panelSource, /await refresh\(\);/);
  assert.doesNotMatch(panelSource, /JSON\.stringify\(\{ status: 'RESCHEDULED' \}\)/);
});

test('la ruta de coordinación conserva la autoridad canónica de booking para reprogramar', () => {
  assert.match(routeSource, /router\.post\('\/interview-management\/candidates\/:candidateId\/coordination'/);
  assert.match(routeSource, /createScheduledInterviewBooking\(tx, \{/);
  assert.match(routeSource, /manualScheduling:\s*true/);
  assert.match(routeSource, /slotId:\s*null/);
  assert.match(routeSource, /INTERVIEW_SCHEDULE_CHANGED/);
});

test('Del día integra candidato y asistencia en una tarjeta sin superponer dos tarjetas', () => {
  assert.match(uiSource, /if \(attendanceOnly\) item\.classList\.add\('ic-manual-day-card'\)/);
  assert.match(uiSource, /\.ic-manual-day-card\{gap:0;border:1px solid #dbe5ef;border-radius:10px;background:#fff;overflow:hidden\}/);
  assert.match(uiSource, /\.ic-manual-day-card>\.ic-row\{border:0;border-radius:0;background:transparent\}/);
  assert.match(uiSource, /\.ic-manual-day-card>\.ic-day-panel\{border:0;border-top:1px solid #e2e8f0;border-radius:0/);
});

test('Asistencia real sigue localmente a Gestión aunque todavía no se haya guardado', () => {
  const rowStart = uiSource.indexOf('function renderRow(');
  const rowEnd = uiSource.indexOf('\n  function configureTabPanel', rowStart);
  const rowSource = uiSource.slice(rowStart, rowEnd);
  assert.match(rowSource, /onManagementStatusChange = null/);
  assert.match(rowSource, /management\.addEventListener\('change', syncDateVisibility\)/);
  assert.match(rowSource, /onManagementStatusChange\(management\.value\)/);

  const groupStart = uiSource.indexOf('async function appendManagedInterviewGroup(');
  const groupEnd = uiSource.indexOf('\n  function createTabButton', groupStart);
  const groupSource = uiSource.slice(groupStart, groupEnd);
  assert.match(groupSource, /attendancePanel\.hidden = nextStatus !== 'CONFIRMED'/);
  assert.match(groupSource, /onManagementStatusChange: attendanceOnly \? syncAttendancePanel : null/);
  assert.match(groupSource, /attendancePanel\.hidden = managementStatus !== 'CONFIRMED'/);
  assert.doesNotMatch(groupSource, /window\.location|location\.reload/);
});
