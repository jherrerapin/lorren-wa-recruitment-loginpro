import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sortInterviewCoordinationEntries } from '../src/routes/interviewOutreachManagement.js';

const routeSource = readFileSync(new URL('../src/routes/interviewOutreachManagement.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../src/public/interview-outreach-management.js', import.meta.url), 'utf8');

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

test('la gestión reutiliza Review y Booking, sin derivar respuestas WhatsApp ni cambiar Candidate a rechazado', () => {
  assert.match(routeSource, /setInterviewInvitationStatus/);
  assert.match(routeSource, /listOfferableSlots/);
  assert.match(routeSource, /createBooking/);
  assert.match(routeSource, /cancelCandidateBookings/);
  assert.match(routeSource, /interviewBookings/);
  assert.match(routeSource, /router\.post\('\/interview-management\/candidates\/:candidateId\/coordination'/);
  assert.doesNotMatch(routeSource, /deriveInterviewOutreachAttendance/);
  assert.doesNotMatch(routeSource, /direction:\s*'INBOUND'/);
  assert.doesNotMatch(routeSource, /status:\s*['"]RECHAZADO['"]/);
  assert.doesNotMatch(routeSource, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
});

test('la interfaz vive dentro de cada vacante y usa No interesado sin diálogos nativos', () => {
  assert.match(uiSource, /data-vacancy-panel/);
  assert.match(uiSource, /Coordinación de entrevistas/);
  assert.match(uiSource, /Pendiente de respuesta/);
  assert.match(uiSource, /Confirmó entrevista/);
  assert.match(uiSource, /No interesado/);
  assert.match(uiSource, /Día y hora de entrevista/);
  assert.match(uiSource, /\/coordination/);
  assert.doesNotMatch(uiSource, /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
});
