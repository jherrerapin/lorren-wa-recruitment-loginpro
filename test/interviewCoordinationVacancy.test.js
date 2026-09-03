import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sortInterviewCoordinationEntries } from '../src/routes/interviewOutreachManagement.js';

const routeSource = readFileSync(new URL('../src/routes/interviewOutreachManagement.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../src/public/interview-outreach-management.js', import.meta.url), 'utf8');
const schemaSource = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const migrationSource = readFileSync(
  new URL('../prisma/migrations/20260903163000_manual_interview_booking_without_slot/migration.sql', import.meta.url),
  'utf8'
);

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
  assert.match(uiSource, /Coordinación de entrevistas/);
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
  assert.match(uiSource, /'Entrevistas programadas'/);
  assert.match(uiSource, /'No interesados'/);
  assert.match(uiSource, /await refresh\(\)/);
  assert.match(uiSource, /Gestiona primero las respuestas pendientes/);
});

test('el día de la entrevista amplía la tabla existente sin crear otra agenda paralela', () => {
  assert.match(uiSource, /function bogotaToday/);
  assert.match(uiSource, /timeZone: 'America\/Bogota'/);
  assert.match(uiSource, /selectedDashboardDate/);
  assert.match(uiSource, /\[data-vacancy-panel\] \.bookings-table/);
  assert.match(uiSource, /candidateIdFromBookingRow/);
  assert.match(uiSource, /Gestión del día de entrevista/);
  assert.match(uiSource, /Asistencia real, evaluación e información complementaria/);
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
