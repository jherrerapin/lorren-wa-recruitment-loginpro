import test from 'node:test';
import assert from 'node:assert/strict';
import { canScheduleReminderPolicy, isWithinWhatsappWindow } from '../src/services/reminderPolicy.js';
import { buildReminderText, runReminderDispatcher } from '../src/services/reminder.js';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { installOpenAIMock } from './helpers/mockOpenAI.js';

test('canScheduleReminder permite estados pendientes y bloquea DONE/RECHAZADO', () => {
  const base = {
    status: 'NUEVO',
    currentStep: 'COLLECTING_DATA',
    reminderState: 'NONE',
    lastInboundAt: new Date()
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

test('si está pausado no es elegible para recordatorio automático', () => {
  const pausedCandidate = {
    status: 'NUEVO',
    currentStep: 'COLLECTING_DATA',
    reminderState: 'NONE',
    lastInboundAt: new Date(),
    botPaused: true
  };
  assert.equal(canScheduleReminderPolicy(pausedCandidate), false);
});

test('buildReminderText especifica solo la hoja de vida cuando es lo único faltante', () => {
  const text = buildReminderText({
    fullName: 'William Alberto Cachaya',
    documentType: 'CC',
    documentNumber: '1104940144',
    age: 20,
    neighborhood: 'Sur',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    cvData: null
  });

  assert.match(text, /tu hoja de vida/i);
  assert.doesNotMatch(text, /datos faltantes/i);
  assert.doesNotMatch(text, /nombre completo/i);
});

test('buildReminderText especifica exactamente los campos faltantes y la HV cuando aplica', () => {
  const text = buildReminderText({
    fullName: 'William Alberto Cachaya',
    documentType: 'CC',
    documentNumber: '1104940144',
    age: 20,
    neighborhood: null,
    medicalRestrictions: null,
    transportMode: 'Moto',
    cvData: null
  });

  assert.match(text, /barrio/i);
  assert.match(text, /restricciones médicas/i);
  assert.match(text, /hoja de vida/i);
  assert.doesNotMatch(text, /datos faltantes/i);
});

test('buildReminderText pide localidad para vacantes de Bogota', () => {
  const text = buildReminderText({
    fullName: 'Laura Gomez',
    documentType: 'CC',
    documentNumber: '123456789',
    age: 29,
    locality: null,
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    cvData: null,
    vacancy: { city: 'Bogota' }
  });

  assert.match(text, /localidad/i);
  assert.doesNotMatch(text, /barrio/i);
});

test('runReminderDispatcher envía recordatorio contextualizado según lo que falta', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';

  const now = new Date('2026-04-07T20:36:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-reminder-1',
      phone: '573001112233',
      status: 'NUEVO',
      currentStep: 'ASK_CV',
      reminderState: 'SCHEDULED',
      reminderScheduledFor: new Date('2026-04-07T20:35:00.000Z'),
      lastInboundAt: new Date('2026-04-07T19:50:00.000Z'),
      fullName: 'William Alberto Cachaya',
      documentType: 'CC',
      documentNumber: '1104940144',
      age: 20,
      neighborhood: 'Sur',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto',
      cvData: null
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    await runReminderDispatcher(prisma, { now });
    assert.equal(whatsappMock.sentMessages.length, 1);
    assert.match(whatsappMock.sentMessages[0].body, /hoja de vida/i);
    assert.doesNotMatch(whatsappMock.sentMessages[0].body, /datos faltantes/i);
    assert.equal(prisma.state.candidates[0].reminderState, 'SENT');
  } finally {
    restoreAxios();
  }
});
