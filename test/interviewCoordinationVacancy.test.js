import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sortInterviewCoordinationEntries } from '../src/routes/interviewOutreachManagement.js';

const routeSource = readFileSync(new URL('../src/routes/interviewOutreachManagement.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../src/public/interview-outreach-management.js', import.meta.url), 'utf8');
const schemaSource = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const migrationSource = readFileSync(
  new URL('../prisma/migrations/20260903163000_manual_interview_booking_without_slot/migration.sql', import.meta.url),
  'utf8'
);

function loadCoordinationGroupingHarness() {
  const marker = "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });\n  else start();\n})();";
  assert.ok(uiSource.includes(marker), 'No se encontró el cierre esperado del cliente de coordinación');
  const instrumented = uiSource.replace(
    marker,
    "  globalThis.__coordinationHarness = { bogotaDay, isManualBooking, splitCoordinationEntries };\n})();"
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
  return sandbox.__coordinationHarness;
}

test('coordinación por vacante prioriza pendientes, luego entrevistas confirmadas y al final no interesados', () => {
  const entries = sortInterviewCoordinationEntries([
    {
      candidateId: 'candidate-declined-test',
      invitation: { status: 'DECLINED' },
      contactedAt: new Date('2026-09-02T14:00:00.000Z')
    },
    {
      candidateId: 'candidate-confirmed-later-test',
      invitation: { status: 'CONFIRMED' },
      booking: { scheduledAt: new Date('2026-09-05T15:00:00.000Z') }
    },
    {
      candidateId: 'candidate-pending-test',
      invitation: { status: 'PENDING' },
      contactedAt: new Date('2026-09-03T14:00:00.000Z')
    },
    {
      candidateId: 'candidate-confirmed-sooner-test',
      invitation: { status: 'CONFIRMED' },
      booking: { scheduledAt: new Date('2026-09-04T13:00:00.000Z') }
    }
  ]);

  assert.deepEqual(entries.map((entry) => entry.candidateId), [
    'candidate-pending-test',
    'candidate-confirmed-sooner-test',
    'candidate-confirmed-later-test',
    'candidate-declined-test'
  ]);
});

test('la coordinación humana usa Booking canónico sin depender de slots configurados', () => {
  assert.match(routeSource, /setInterviewInvitationStatus/);
  assert.match(routeSource, /createScheduledInterviewBooking/);
  assert.match(routeSource, /manualScheduling:\s*true/);
  assert.match(routeSource, /slotId:\s*null/);
  assert.match(routeSource, /cancelCandidateBookings/);
  assert.match(routeSource, /interviewBookings/);
  assert.match(routeSource, /buildVacancyAccessWhere/);
  assert.match(routeSource, /interview_management_vacancy_not_found/);
  assert.match(routeSource, /interview_management_datetime_required/);
  assert.match(routeSource, /router\.post\('\/interview-management\/candidates\/:candidateId\/coordination'/);
  assert.doesNotMatch(routeSource, /listOfferableSlots/);
  assert.doesNotMatch(routeSource, /createBooking\s*\(/);
  assert.doesNotMatch(routeSource, /deriveInterviewOutreachAttendance/);
  assert.doesNotMatch(routeSource, /direction:\s*'INBOUND'/);
  assert.doesNotMatch(routeSource, /status:\s*['"]RECHAZADO['"]/);
  assert.doesNotMatch(routeSource, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
});

test('No interesado oculta inmediatamente fecha y entrevista; Confirmó usa fecha libre', () => {
  assert.match(uiSource, /data-vacancy-panel/);
  assert.match(uiSource, /Coordinación manual de entrevistas/);
  assert.match(uiSource, /Pendiente de respuesta/);
  assert.match(uiSource, /Confirmó entrevista/);
  assert.match(uiSource, /No interesado/);
  assert.match(uiSource, /Día y hora de entrevista/);
  assert.match(uiSource, /input\.type = 'datetime-local'/);
  assert.match(uiSource, /dateField\.hidden = !confirmed/);
  assert.match(uiSource, /bookingMeta\.hidden = !confirmed/);
  assert.match(uiSource, /management\.value === 'CONFIRMED'/);
  assert.match(uiSource, /body\.scheduledAt = scheduledAt/);
  assert.match(uiSource, /\/coordination/);
  assert.doesNotMatch(uiSource, /availableSlots/);
  assert.doesNotMatch(uiSource, /interviewSlotSelect/);
  assert.doesNotMatch(uiSource, /parseSlotValue/);
  assert.doesNotMatch(uiSource, /body\.slotId/);
  assert.doesNotMatch(uiSource, /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
});

test('guardar una confirmación mueve visualmente la persona de pendientes a entrevistas programadas', () => {
  assert.match(uiSource, /function splitCoordinationEntries/);
  assert.match(uiSource, /status === 'CONFIRMED' && entry\?\.booking\?\.scheduledAt/);
  assert.match(uiSource, /'Pendientes de respuesta'/);
  assert.match(uiSource, /'Entrevistas programadas para la fecha seleccionada'/);
  assert.match(uiSource, /'No interesados'/);
  assert.match(uiSource, /await refresh\(\)/);
});

test('la coordinación usa pestañas compactas y conserva la sección activa al refrescar', () => {
  assert.match(uiSource, /className\) node\.className = className/);
  assert.match(uiSource, /function installTabNavigation/);
  assert.match(uiSource, /function activateCoordinationTab/);
  assert.match(uiSource, /role', 'tablist'/);
  assert.match(uiSource, /role', 'tab'/);
  assert.match(uiSource, /role', 'tabpanel'/);
  assert.match(uiSource, /aria-selected/);
  assert.match(uiSource, /data\.activeCoordinationTab|dataset\.activeCoordinationTab/);
  assert.match(uiSource, /previousActiveKey = current\?\.dataset\.activeCoordinationTab \|\| 'pending'/);
  assert.match(uiSource, /panel\.hidden = panel\.dataset\.interviewCoordinationPanel !== activeKey/);
  assert.match(uiSource, /\['pending', 'Por gestionar'/);
  assert.match(uiSource, /\['selected', 'Del día'/);
  assert.match(uiSource, /\['scheduled', 'Programadas'/);
  assert.match(uiSource, /\['declined', 'No interesados'/);
  assert.match(uiSource, /overflow-x:auto/);
  assert.doesNotMatch(uiSource, /\.scrollIntoView\s*\(/);
});

test('el proceso manual permite gestión completa para la fecha seleccionada, incluso si es pasada', () => {
  assert.match(uiSource, /selectedDashboardDate/);
  assert.match(uiSource, /timeZone: 'America\/Bogota'/);
  assert.match(uiSource, /isManualBooking/);
  assert.match(uiSource, /entry\?\.booking\?\.slotId == null/);
  assert.match(uiSource, /'Entrevistas manuales — fecha seleccionada'/);
  assert.match(uiSource, /appendManagedInterviewGroup/);
  assert.match(uiSource, /Gestión de entrevista/);
  assert.match(uiSource, /Información complementaria/);
  assert.doesNotMatch(uiSource, /isTodayDashboard/);
  assert.doesNotMatch(uiSource, /Entrevistas manuales — Hoy/);
  assert.doesNotMatch(uiSource, /schedulingEnabled/);
});

test('fecha seleccionada filtra confirmadas y mantiene pendientes/no interesados globales', () => {
  const { splitCoordinationEntries } = loadCoordinationGroupingHarness();
  const entries = [
    {
      candidateId: 'TEST-PENDING',
      invitation: { status: 'PENDING' }
    },
    {
      candidateId: 'TEST-DECLINED',
      invitation: { status: 'DECLINED' }
    },
    {
      candidateId: 'TEST-MANUAL-SEP03',
      invitation: { status: 'CONFIRMED' },
      booking: { scheduledAt: '2026-09-03T20:00:00.000Z', slotId: null }
    },
    {
      candidateId: 'TEST-MANUAL-SEP04',
      invitation: { status: 'CONFIRMED' },
      booking: { scheduledAt: '2026-09-04T20:00:00.000Z', slotId: null }
    },
    {
      candidateId: 'TEST-AUTO-SEP03',
      invitation: { status: 'CONFIRMED' },
      booking: { scheduledAt: '2026-09-03T21:00:00.000Z', slotId: 'TEST-SLOT-SEP03' }
    }
  ];

  const sep03 = splitCoordinationEntries(entries, '2026-09-03');
  assert.deepEqual(Array.from(sep03.pending, (entry) => entry.candidateId), ['TEST-PENDING']);
  assert.deepEqual(Array.from(sep03.declined, (entry) => entry.candidateId), ['TEST-DECLINED']);
  assert.deepEqual(Array.from(sep03.selected, (entry) => entry.candidateId), ['TEST-MANUAL-SEP03']);
  assert.deepEqual(Array.from(sep03.scheduled, (entry) => entry.candidateId), ['TEST-AUTO-SEP03']);

  const sep04 = splitCoordinationEntries(entries, '2026-09-04');
  assert.deepEqual(Array.from(sep04.pending, (entry) => entry.candidateId), ['TEST-PENDING']);
  assert.deepEqual(Array.from(sep04.declined, (entry) => entry.candidateId), ['TEST-DECLINED']);
  assert.deepEqual(Array.from(sep04.selected, (entry) => entry.candidateId), ['TEST-MANUAL-SEP04']);
  assert.deepEqual(Array.from(sep04.scheduled, (entry) => entry.candidateId), []);
});

test('manual y automático coexisten sin duplicar la misma cita en el visualizador automático', () => {
  assert.match(uiSource, /function separateAutomaticInterviews/);
  assert.match(uiSource, /function findAutomaticInterviewSection/);
  assert.match(uiSource, /Entrevistas automáticas/);
  assert.match(uiSource, /manualCandidateIds/);
  assert.match(uiSource, /candidateIdFromBookingRow/);
  assert.match(uiSource, /row\.remove\(\)/);
  assert.match(uiSource, /found\.section\.hidden = true/);
  assert.doesNotMatch(uiSource, /createScheduledInterviewBooking/);
});

test('gestión del día reutiliza APIs canónicas para asistencia, evaluación y complementarios', () => {
  assert.match(uiSource, /ATTENDANCE_OPTIONS/);
  assert.match(uiSource, /\['ATTENDED', 'Asistió'\]/);
  assert.match(uiSource, /\['NO_SHOW', 'No asistió'\]/);
  assert.match(uiSource, /\/attendance/);
  assert.match(uiSource, /\/evaluation/);
  assert.match(uiSource, /ratingInput\.min = '1'/);
  assert.match(uiSource, /ratingInput\.max = '5'/);
  assert.match(uiSource, /ratingInput\.step = '0\.01'/);
  assert.match(uiSource, /observationEnabled/);
  assert.match(uiSource, /complementaryFields/);
  assert.match(uiSource, /values: complementaryInputs\.map/);
  assert.doesNotMatch(uiSource, /\/webhook/);
  assert.doesNotMatch(uiSource, /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
});

test('Prisma y migración representan booking manual sin fabricar InterviewSlot', () => {
  assert.match(schemaSource, /slotId\s+String\?/);
  assert.match(schemaSource, /slot\s+InterviewSlot\?\s+@relation\(fields: \[slotId\], references: \[id\]\)/);
  assert.match(migrationSource, /ALTER COLUMN "slotId" DROP NOT NULL/);
});