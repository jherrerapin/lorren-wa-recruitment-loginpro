import test from 'node:test';
import assert from 'node:assert/strict';
import { canScheduleReminderPolicy, isWithinWhatsappWindow } from '../src/services/reminderPolicy.js';

test('canScheduleReminder permite estados pendientes y bloquea estados cerrados o pausados', () => {
  const base = {
    status: 'NUEVO',
    currentStep: 'COLLECTING_DATA',
    reminderState: 'NONE',
    lastInboundAt: new Date(),
    botPaused: false
  };

  assert.equal(canScheduleReminderPolicy(base), true);
  assert.equal(canScheduleReminderPolicy({ ...base, currentStep: 'DONE' }), false);
  assert.equal(canScheduleReminderPolicy({ ...base, status: 'RECHAZADO' }), false);
  assert.equal(canScheduleReminderPolicy({ ...base, botPaused: true }), false);
});

test('isWithinWhatsappWindow valida ventana de 24 horas', () => {
  const recent = new Date(Date.now() - (23 * 60 * 60 * 1000));
  const old = new Date(Date.now() - (25 * 60 * 60 * 1000));

  assert.equal(isWithinWhatsappWindow(recent), true);
  assert.equal(isWithinWhatsappWindow(old), false);
});
