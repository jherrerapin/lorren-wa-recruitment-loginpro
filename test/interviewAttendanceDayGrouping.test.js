import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isInterviewedCandidateReview } from '../src/services/interviewOutreachManagement.js';

const uiSource = readFileSync(new URL('../src/public/interview-outreach-management.js', import.meta.url), 'utf8');

function loadGroupingHarness() {
  const marker = "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });\n  else start();\n})();";
  assert.ok(uiSource.includes(marker), 'No se encontró el cierre esperado del cliente de entrevistas');
  const instrumented = uiSource.replace(
    marker,
    "  globalThis.__attendanceDayHarness = { splitCoordinationEntries };\n})();"
  );
  const sandbox = {
    console,
    Date,
    Intl,
    URL,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(instrumented, sandbox, { filename: 'interview-outreach-management.js' });
  return sandbox.__attendanceDayHarness;
}

function entry(candidateId, attendanceStatus, scheduledAt, slotId = null) {
  return {
    candidateId,
    invitation: { status: 'CONFIRMED' },
    attendance: { status: attendanceStatus },
    evaluation: { rating: null },
    booking: { scheduledAt, slotId }
  };
}

test('Del día conserva solo asistencia pendiente y saca inmediatamente estados resueltos', () => {
  const { splitCoordinationEntries } = loadGroupingHarness();
  const entries = [
    entry('TEST-PENDING', 'PENDING', '2026-09-04T20:00:00.000Z'),
    entry('TEST-ATTENDED', 'ATTENDED', '2026-09-04T21:00:00.000Z'),
    entry('TEST-NO-SHOW', 'NO_SHOW', '2026-09-04T22:00:00.000Z')
  ];

  const groups = splitCoordinationEntries(entries, '2026-09-04');

  assert.deepEqual(Array.from(groups.selected, (item) => item.candidateId), ['TEST-PENDING']);
  assert.deepEqual(Array.from(groups.evaluation, (item) => item.candidateId), ['TEST-ATTENDED']);
  assert.deepEqual(Array.from(groups.noShow, (item) => item.candidateId), ['TEST-NO-SHOW']);
});

test('asistencia resuelta no vuelve a Programadas aunque la reserva sea automática', () => {
  const { splitCoordinationEntries } = loadGroupingHarness();
  const groups = splitCoordinationEntries([
    entry('TEST-AUTO-PENDING', 'PENDING', '2026-09-04T20:00:00.000Z', 'TEST-SLOT-1'),
    entry('TEST-AUTO-ATTENDED', 'ATTENDED', '2026-09-04T21:00:00.000Z', 'TEST-SLOT-2'),
    entry('TEST-AUTO-NO-SHOW', 'NO_SHOW', '2026-09-04T22:00:00.000Z', 'TEST-SLOT-3')
  ], '2026-09-04');

  assert.deepEqual(Array.from(groups.scheduled, (item) => item.candidateId), ['TEST-AUTO-PENDING']);
  assert.deepEqual(Array.from(groups.evaluation, (item) => item.candidateId), ['TEST-AUTO-ATTENDED']);
  assert.deepEqual(Array.from(groups.noShow, (item) => item.candidateId), ['TEST-AUTO-NO-SHOW']);
});

test('Asistió sin calificación permanece operable y solo con calificación entra a Entrevistados', () => {
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: null }), false);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: '4,20' }), true);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'NO_SHOW', rating: '4,20' }), false);
});

test('la UI conserva acceso para corregir asistencia y usa destinos coherentes después del refresh', () => {
  assert.match(uiSource, /\['evaluation', 'Por evaluar', groups\.evaluation\.length\]/);
  assert.match(uiSource, /\['no-show', 'No asistieron', groups\.noShow\.length\]/);
  assert.match(uiSource, /attendance\.value === 'ATTENDED'[\s\S]*\? 'evaluation'/);
  assert.match(uiSource, /attendance\.value === 'NO_SHOW'[\s\S]*\? 'no-show'/);
  assert.match(uiSource, /await refresh\(destinationTab\)/);
  assert.match(uiSource, /await refresh\('interviewed'\)/);
  assert.match(uiSource, /appendManagedInterviewGroup/);
});
