import test from 'node:test';
import assert from 'node:assert/strict';

import { canScheduleReminderPolicy } from '../src/services/reminderPolicy.js';
import { CANDIDATE_PROCESS_REMINDER_DELAY_MS } from '../src/services/reminder.js';

function candidate(overrides = {}) {
  return {
    id: 'cand-reminder-policy',
    status: 'NUEVO',
    currentStep: 'GREETING_SENT',
    botResumeMode: null,
    reminderState: null,
    lastReminderAt: null,
    lastInboundAt: new Date('2026-06-03T12:00:00-05:00'),
    botPaused: false,
    ...overrides
  };
}

test('recordatorio de proceso incompleto queda configurado por defecto a dos horas', () => {
  assert.equal(CANDIDATE_PROCESS_REMINDER_DELAY_MS, 2 * 60 * 60 * 1000);
});

test('permite recordatorio solo cuando hay proceso abierto y elegible', () => {
  assert.equal(canScheduleReminderPolicy(candidate({ currentStep: 'COLLECTING_DATA' })), true);
});

test('bloquea recordatorio cuando espera consentimiento de perfil futuro', () => {
  assert.equal(canScheduleReminderPolicy(candidate({ botResumeMode: 'future_profile_offer' })), false);
});

test('bloquea recordatorio cuando espera decisión por vacante pausada', () => {
  assert.equal(canScheduleReminderPolicy(candidate({ botResumeMode: 'paused_vacancy' })), false);
});

test('bloquea recordatorio cuando espera aceptación de alternativa abierta', () => {
  assert.equal(canScheduleReminderPolicy(candidate({ botResumeMode: 'alternative_vacancy_offer:vac-cargue-bogota' })), false);
});

test('bloquea recordatorio cuando espera prevalidación de alternativa especializada', () => {
  assert.equal(canScheduleReminderPolicy(candidate({ botResumeMode: 'alternative_vacancy_prequalification:vac-lider-ibague' })), false);
});
