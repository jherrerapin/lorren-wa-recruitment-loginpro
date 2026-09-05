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
    "  globalThis.__attendanceDayHarness = { splitCoordinationEntries, resolveInterviewEntryDay, filterInterviewEntriesBySelectedDay };\n})();"
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
  assert.deepEqual(Array.from(groups.attendedPending, (item) => item.candidateId), ['TEST-ATTENDED']);
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
  assert.deepEqual(Array.from(groups.attendedPending, (item) => item.candidateId), ['TEST-AUTO-ATTENDED']);
  assert.deepEqual(Array.from(groups.noShow, (item) => item.candidateId), ['TEST-AUTO-NO-SHOW']);
});

test('la fecha seleccionada limita Por gestionar, Del día, Programadas, No asistieron y No interesados', () => {
  const { filterInterviewEntriesBySelectedDay, splitCoordinationEntries } = loadGroupingHarness();
  const selectedDay = '2026-09-04';
  const entries = [
    {
      candidateId: 'TEST-PENDING-SEP04',
      invitation: { status: 'PENDING' },
      attendance: { status: 'PENDING' },
      contactedAt: '2026-09-04T15:00:00.000Z'
    },
    {
      candidateId: 'TEST-PENDING-SEP03',
      invitation: { status: 'PENDING' },
      attendance: { status: 'PENDING' },
      contactedAt: '2026-09-03T15:00:00.000Z'
    },
    {
      candidateId: 'TEST-MANUAL-SEP04',
      invitation: { status: 'CONFIRMED' },
      attendance: { status: 'PENDING' },
      booking: { scheduledAt: '2026-09-04T20:00:00.000Z', slotId: null }
    },
    {
      candidateId: 'TEST-MANUAL-SEP03',
      invitation: { status: 'CONFIRMED' },
      attendance: { status: 'PENDING' },
      booking: { scheduledAt: '2026-09-03T20:00:00.000Z', slotId: null }
    },
    {
      candidateId: 'TEST-AUTO-SEP04',
      invitation: { status: 'CONFIRMED' },
      attendance: { status: 'PENDING' },
      booking: { scheduledAt: '2026-09-04T21:00:00.000Z', slotId: 'TEST-SLOT-SEP04' }
    },
    {
      candidateId: 'TEST-AUTO-SEP03',
      invitation: { status: 'CONFIRMED' },
      attendance: { status: 'PENDING' },
      booking: { scheduledAt: '2026-09-03T21:00:00.000Z', slotId: 'TEST-SLOT-SEP03' }
    },
    {
      candidateId: 'TEST-NO-SHOW-SEP04',
      invitation: { status: 'CONFIRMED' },
      attendance: { status: 'NO_SHOW', updatedAt: '2026-09-04T22:00:00.000Z' },
      booking: null
    },
    {
      candidateId: 'TEST-NO-SHOW-SEP03',
      invitation: { status: 'CONFIRMED' },
      attendance: { status: 'NO_SHOW', updatedAt: '2026-09-03T22:00:00.000Z' },
      booking: null
    },
    {
      candidateId: 'TEST-DECLINED-SEP04',
      invitation: { status: 'DECLINED', updatedAt: '2026-09-04T16:00:00.000Z' },
      attendance: { status: 'PENDING' },
      booking: null
    },
    {
      candidateId: 'TEST-DECLINED-SEP03',
      invitation: { status: 'DECLINED', updatedAt: '2026-09-03T16:00:00.000Z' },
      attendance: { status: 'PENDING' },
      booking: null
    }
  ];

  const filtered = filterInterviewEntriesBySelectedDay(entries, selectedDay);
  const groups = splitCoordinationEntries(filtered, selectedDay);

  assert.deepEqual(Array.from(groups.pending, (item) => item.candidateId), ['TEST-PENDING-SEP04']);
  assert.deepEqual(Array.from(groups.selected, (item) => item.candidateId), ['TEST-MANUAL-SEP04']);
  assert.deepEqual(Array.from(groups.scheduled, (item) => item.candidateId), ['TEST-AUTO-SEP04']);
  assert.deepEqual(Array.from(groups.noShow, (item) => item.candidateId), ['TEST-NO-SHOW-SEP04']);
  assert.deepEqual(Array.from(groups.declined, (item) => item.candidateId), ['TEST-DECLINED-SEP04']);
});

test('Entrevistados y pendientes de calificación usan el mismo filtro de fecha', () => {
  const { filterInterviewEntriesBySelectedDay } = loadGroupingHarness();
  const interviewed = [
    {
      candidateId: 'TEST-INTERVIEWED-SEP04',
      attendance: { status: 'ATTENDED', updatedAt: '2026-09-04T22:00:00.000Z' },
      evaluation: { rating: 4.2 },
      booking: null
    },
    {
      candidateId: 'TEST-INTERVIEWED-SEP03',
      attendance: { status: 'ATTENDED', updatedAt: '2026-09-03T22:00:00.000Z' },
      evaluation: { rating: 4.4 },
      booking: null
    },
    {
      candidateId: 'TEST-ATTENDED-PENDING-SEP04',
      attendance: { status: 'ATTENDED', updatedAt: '2026-09-04T23:00:00.000Z' },
      evaluation: { rating: null },
      booking: null
    },
    {
      candidateId: 'TEST-ATTENDED-PENDING-SEP03',
      attendance: { status: 'ATTENDED', updatedAt: '2026-09-03T23:00:00.000Z' },
      evaluation: { rating: null },
      booking: null
    }
  ];

  assert.deepEqual(
    Array.from(filterInterviewEntriesBySelectedDay(interviewed, '2026-09-04'), (item) => item.candidateId),
    ['TEST-INTERVIEWED-SEP04', 'TEST-ATTENDED-PENDING-SEP04']
  );
});

test('la fecha de la reserva gana sobre timestamps de gestión y un dato sin fecha no se convierte en hoy', () => {
  const { resolveInterviewEntryDay } = loadGroupingHarness();
  assert.equal(resolveInterviewEntryDay({
    invitation: { status: 'DECLINED', updatedAt: '2026-09-03T15:00:00.000Z' },
    attendance: { status: 'NO_SHOW', updatedAt: '2026-09-03T16:00:00.000Z' },
    contactedAt: '2026-09-03T14:00:00.000Z',
    booking: { scheduledAt: '2026-09-04T20:00:00.000Z', slotId: null }
  }), '2026-09-04');
  assert.equal(resolveInterviewEntryDay({}), '');
});

test('sin fecha seleccionada el filtro conserva todas las entradas', () => {
  const { filterInterviewEntriesBySelectedDay } = loadGroupingHarness();
  const entries = [
    { candidateId: 'TEST-A', contactedAt: '2026-09-03T15:00:00.000Z' },
    { candidateId: 'TEST-B', contactedAt: '2026-09-04T15:00:00.000Z' }
  ];
  assert.deepEqual(
    Array.from(filterInterviewEntriesBySelectedDay(entries, ''), (item) => item.candidateId),
    ['TEST-A', 'TEST-B']
  );
});

test('el ranking canónico sigue exigiendo calificación aunque Asistió ya se muestre en Entrevistados', () => {
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: null }), false);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: '4,20' }), true);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'NO_SHOW', rating: '4,20' }), false);
});

test('Asistió va a Entrevistados con alerta visual hasta recibir calificación', () => {
  assert.doesNotMatch(uiSource, /'Por evaluar'/);
  assert.match(uiSource, /\['interviewed', 'Entrevistados', interviewed\.length \+ groups\.attendedPending\.length\]/);
  assert.match(uiSource, /attendance\.value === 'ATTENDED'[\s\S]*\? 'interviewed'/);
  assert.match(uiSource, /attendance\.value === 'NO_SHOW'[\s\S]*\? 'no-show'/);
  assert.match(uiSource, /await refresh\(destinationTab\)/);
  assert.match(uiSource, /Pendiente de calificación/);
  assert.match(uiSource, /ic-attended-pending/);
  assert.match(uiSource, /#f59e0b/);
  assert.match(uiSource, /#fffbeb/);
  assert.match(uiSource, /appendReviewedGroup\(board, visibleInterviewed, groups\.attendedPending/);
});

test('No asistió conserva una bandeja propia para trazabilidad y corrección', () => {
  assert.match(uiSource, /\['no-show', 'No asistieron', groups\.noShow\.length\]/);
  assert.match(uiSource, /tabKey: 'no-show'/);
  assert.match(uiSource, /title: 'No asistieron'/);
  assert.match(uiSource, /appendManagedInterviewGroup/);
});

test('renderBoard filtra entradas y entrevistados antes de contadores y render de pestañas', () => {
  assert.match(uiSource, /const visibleEntries = filterInterviewEntriesBySelectedDay\(entries, selectedDay\)/);
  assert.match(uiSource, /const visibleInterviewed = filterInterviewEntriesBySelectedDay\(interviewed, selectedDay\)/);
  assert.match(uiSource, /const groups = splitCoordinationEntries\(visibleEntries, selectedDay\)/);
  assert.match(uiSource, /installTabNavigation\(board, vacancyId, groups, visibleInterviewed, activeKey\)/);
  assert.match(uiSource, /appendReviewedGroup\(board, visibleInterviewed, groups\.attendedPending/);
});
