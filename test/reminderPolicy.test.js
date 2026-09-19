import test from 'node:test';
import assert from 'node:assert/strict';

import { canScheduleReminderPolicy } from '../src/services/reminderPolicy.js';
import { CANDIDATE_PROCESS_REMINDER_DELAY_MS } from '../src/services/reminder.js';
import { processText } from '../src/routes/webhook.js';
import { createDebugTrace } from '../src/services/debugTrace.js';
import { looksLikeNoMedicalRestrictionsText } from '../src/services/candidateData.js';
import { baseOperations, baseVacancies } from './fixtures/conversationCases.js';
import { runConversationCase } from './helpers/conversationHarness.js';

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
    dataConsentStatus: 'ACCEPTED',
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


test('no programa recordatorio mientras espera consentimiento', () => {
  assert.equal(canScheduleReminderPolicy(candidate({ currentStep: 'COLLECTING_DATA', dataConsentStatus: 'PENDING' })), false);
});

test('no programa recordatorio desde GREETING_SENT aunque exista consentimiento', () => {
  assert.equal(canScheduleReminderPolicy(candidate({ currentStep: 'GREETING_SENT', dataConsentStatus: 'ACCEPTED' })), false);
});


test('replay #901: una negación gramatical imperfecta completa restricciones médicas', async () => {
  const result = await runConversationCase({
    id: 'audit-901-natural-no-medical-restrictions',
    steps: ['Ningún restricción médica'],
    candidate: {
      id: 'candidate-audit-medical',
      phone: '573000000907',
      status: 'NUEVO',
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-post',
      fullName: 'Persona Prueba',
      documentType: 'CC',
      documentNumber: 'TEST-901-0007',
      age: 29,
      gender: 'UNKNOWN',
      neighborhood: 'Zona Prueba',
      locality: null,
      medicalRestrictions: null,
      transportMode: 'Bicicleta',
      experienceInfo: null,
      experienceTime: null,
      experienceSummary: null,
      cvData: null,
      cvOriginalName: null,
      cvMimeType: null,
      reminderState: 'NONE',
      reminderScheduledFor: null,
      botPaused: false,
      botPausedAt: null,
      botPauseReason: null,
      botResumeMode: null,
      dataConsentStatus: 'ACCEPTED',
      dataConsentVersion: 'lorren-v2-2026-07-v3',
      lastInboundAt: null,
      lastOutboundAt: null,
      createdAt: new Date('2026-09-01T12:00:00.000Z')
    },
    vacancies: baseVacancies,
    operations: baseOperations,
    expect: {
      candidate: {
        medicalRestrictions: 'Sin restricciones médicas',
        currentStep: 'ASK_CV'
      },
      lastReplyIncludes: ['hoja de vida'],
      lastReplyNotIncludes: ['restricciones medicas']
    }
  }, {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true
  });

  assert.equal(result.debugTraces[0].persisted_fields.includes('medicalRestrictions'), true);
});

test('normaliza concordancia y plural sin convertir una restricción declarada en ausencia', () => {
  for (const text of ['Ningún restricción médica', 'Ninguna restricciones médicas', 'Ninguno restricción médica']) {
    assert.equal(looksLikeNoMedicalRestrictionsText(text), true, text);
  }
  assert.equal(looksLikeNoMedicalRestrictionsText('Tengo una restricción médica'), false);
});
