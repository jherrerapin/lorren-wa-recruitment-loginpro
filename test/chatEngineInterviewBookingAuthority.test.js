import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/services/chatEngine.js', 'utf8');

function between(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return source.slice(startIndex, endIndex);
}

const handler = between(
  'async function handleAppointmentIntentDirectly',
  'async function analyzePausedVacancyConsent'
);

test('chatEngine delega las respuestas de entrevista en la autoridad compartida', () => {
  assert.match(source, /applyInterviewReminderResponse/);
  assert.match(handler, /applyInterviewReminderResponse\(prisma,\s*\{/);
  assert.match(handler, /bookingId:\s*booking\.id/);
  assert.match(handler, /currentStatus:\s*booking\.status/);
  assert.match(handler, /responseText:\s*inboundText/);
  assert.match(handler, /intent/);
});

test('chatEngine no escribe InterviewBooking directamente', () => {
  assert.doesNotMatch(source, /prisma\.interviewBooking\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/);
});

test('una carrera no informa una transición de entrevista como aplicada', () => {
  assert.match(handler, /transition\.count\s*!==\s*1/);
  assert.match(handler, /return\s+null/);
});

test('la reprogramación conserva la reserva y busca alternativa antes de cambiar el paso', () => {
  assert.doesNotMatch(handler, /status:\s*['"]RESCHEDULED['"]/);
  const transitionIndex = handler.indexOf('applyInterviewReminderResponse');
  const alternativeIndex = handler.indexOf('getNextAvailableSlotAfter');
  const candidateUpdateIndex = handler.indexOf('prisma.candidate.update');
  assert.ok(transitionIndex >= 0, 'No se encontró la delegación de la transición.');
  assert.ok(alternativeIndex >= 0, 'No se encontró la búsqueda del horario alternativo.');
  assert.ok(candidateUpdateIndex >= 0, 'No se encontró la actualización del paso del candidato.');
  assert.ok(transitionIndex < alternativeIndex, 'La respuesta debe registrarse antes de buscar la alternativa.');
  assert.ok(alternativeIndex < candidateUpdateIndex, 'La alternativa debe resolverse antes de cambiar el paso.');
});

test('cancelación conserva la limpieza de recordatorio del candidato', () => {
  assert.match(handler, /reminderScheduledFor:\s*null/);
  assert.match(handler, /reminderState:\s*['"]SKIPPED['"]/);
});
