import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInterviewIntent, shouldMarkNoResponse } from '../src/services/interviewLifecycle.js';

const booking = {
  id: 'booking-intent',
  status: 'SCHEDULED',
  scheduledAt: new Date('2026-04-08T22:00:00.000Z'),
  reminderSentAt: new Date('2026-04-08T21:00:00.000Z'),
  reminderWindowClosed: true
};

test('detectInterviewIntent confirma asistencia con respuesta corta después del recordatorio', () => {
  assert.equal(detectInterviewIntent({ text: 'Sí', booking, now: new Date('2026-04-08T21:10:00.000Z') }), 'confirm_attendance');
  assert.equal(detectInterviewIntent({ text: 'claro', booking, now: new Date('2026-04-08T21:10:00.000Z') }), 'confirm_attendance');
});

test('detectInterviewIntent cancela o reagenda usando intención explícita', () => {
  assert.equal(detectInterviewIntent({ text: 'No puedo asistir', booking, now: new Date('2026-04-08T21:10:00.000Z') }), 'cancel_interview');
  assert.equal(detectInterviewIntent({ text: 'Necesito otra fecha', booking, now: new Date('2026-04-08T21:10:00.000Z') }), 'reschedule_interview');
});

test('shouldMarkNoResponse marca silencio posterior al recordatorio en umbral de 5 minutos', () => {
  assert.equal(shouldMarkNoResponse(booking, { now: new Date('2026-04-08T21:55:00.000Z'), hasReminderReply: false }), true);
  assert.equal(shouldMarkNoResponse(booking, { now: new Date('2026-04-08T21:55:00.000Z'), hasReminderReply: true }), false);
});

test('detectInterviewIntent entiende confirmaciones naturales después del recordatorio', () => {
  assert.equal(detectInterviewIntent({ text: 'Voy en camino, ahí estaré puntual', booking, now: new Date('2026-04-08T21:20:00.000Z') }), 'confirm_attendance');
  assert.equal(detectInterviewIntent({ text: 'Listo confirmo mi asistencia', booking, now: new Date('2026-04-08T21:20:00.000Z') }), 'confirm_attendance');
});

test('detectInterviewIntent entiende cancelaciones y reprogramaciones naturales después del recordatorio', () => {
  assert.equal(detectInterviewIntent({ text: 'No voy a poder presentarme hoy', booking, now: new Date('2026-04-08T21:20:00.000Z') }), 'cancel_interview');
  assert.equal(detectInterviewIntent({ text: 'Voy tarde, podemos cambiar la cita?', booking, now: new Date('2026-04-08T21:20:00.000Z') }), 'reschedule_interview');
});
