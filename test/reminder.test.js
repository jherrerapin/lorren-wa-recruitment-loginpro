import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBogotaLocalidad } from '../src/services/geographyNormalization.js';
import { canScheduleReminderPolicy, isWithinWhatsappWindow } from '../src/services/reminderPolicy.js';
import {
  buildReminderText,
  handleInterviewReminderResponse,
  runInterviewReminderDispatcher,
  runReminderDispatcher
} from '../src/services/reminder.js';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { installOpenAIMock } from './helpers/mockOpenAI.js';

const INTERVIEW_10_AM_CO = '2026-04-08T15:00:00.000Z';
const REMINDER_9_00_AM_CO = '2026-04-08T14:00:00.000Z';

function setupWhatsappEnv() {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
}

test('canScheduleReminder permite estados pendientes y bloquea DONE/RECHAZADO', () => {
  const base = {
    status: 'NUEVO',
    currentStep: 'COLLECTING_DATA',
    reminderState: 'NONE',
    lastInboundAt: new Date(),
    dataConsentStatus: 'ACCEPTED'
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

test('buildReminderText especifica solo la hoja de vida cuando es lo único faltante', () => {
  const text = buildReminderText({
    fullName: 'Persona Ejemplo',
    documentType: 'CC',
    documentNumber: 'DOC-TEST-001',
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

test('buildReminderText pide localidad para vacantes de Bogotá', () => {
  const text = buildReminderText({
    fullName: 'Candidata Prueba',
    documentType: 'CC',
    documentNumber: 'DOC-TEST-002',
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
  setupWhatsappEnv();
  const now = new Date('2026-04-07T20:36:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-reminder-1',
      phone: '570000000001',
      status: 'NUEVO',
      currentStep: 'ASK_CV',
      reminderState: 'SCHEDULED',
      reminderScheduledFor: new Date('2026-04-07T20:35:00.000Z'),
      lastInboundAt: new Date('2026-04-07T19:50:00.000Z'),
      dataConsentStatus: 'ACCEPTED',
      fullName: 'Persona Ejemplo',
      documentType: 'CC',
      documentNumber: 'DOC-TEST-003',
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
    assert.equal(prisma.state.candidates[0].reminderState, 'SENT');
  } finally {
    restoreAxios();
  }
});

test('recordatorio de entrevista se envía 1 hora antes y marca reminderSentAt', async () => {
  setupWhatsappEnv();
  const now = new Date(REMINDER_9_00_AM_CO);
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-interview-reminder',
      phone: '570000000002',
      fullName: 'Ana Gomez',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T13:50:00.000Z'),
      botPaused: false
    }],
    interviewBookings: [{
      id: 'booking-reminder',
      candidateId: 'cand-interview-reminder',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date(INTERVIEW_10_AM_CO),
      status: 'SCHEDULED',
      reminderSentAt: null,
      reminderWindowClosed: false
    }],
    vacancies: [{
      id: 'vac',
      isActive: true,
      schedulingEnabled: true,
      title: 'Auxiliar de bodega Fontibon',
      role: 'Auxiliar de bodega',
      interviewAddress: 'Calle 80 # 12-34'
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    await runInterviewReminderDispatcher(prisma, { now, candidateId: 'cand-interview-reminder' });
    assert.equal(whatsappMock.sentMessages.length, 1);
    assert.match(whatsappMock.sentMessages[0].body, /te recuerdo que tienes entrevista|confirmas tu asistencia/i);
    assert.equal(prisma.state.interviewBookings[0].reminderSentAt.toISOString(), now.toISOString());
  } finally {
    restoreAxios();
  }
});

async function assertReminderTransition({ candidateText, expectedStatus, expectedIntent = null }) {
  setupWhatsappEnv();
  process.env.ADMIN_WHATSAPP_NUMBER = '570000000099';
  const now = new Date('2026-04-08T14:30:00.000Z');
  const candidateId = `candidate-${expectedStatus.toLowerCase()}`;
  const prisma = createMockPrisma({
    candidates: [{
      id: candidateId,
      phone: '570000000005',
      fullName: 'Candidata Ficticia',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T14:25:00.000Z'),
      botPaused: false,
      vacancyId: 'vacancy-test'
    }],
    vacancies: [{
      id: 'vacancy-test',
      title: 'Cargo de prueba',
      role: 'Rol ficticio',
      interviewAddress: 'Dirección de prueba'
    }],
    interviewBookings: [{
      id: `booking-${expectedStatus.toLowerCase()}`,
      candidateId,
      vacancyId: 'vacancy-test',
      slotId: 'slot-test',
      scheduledAt: new Date(INTERVIEW_10_AM_CO),
      status: 'SCHEDULED',
      reminderSentAt: new Date(REMINDER_9_00_AM_CO),
      reminderWindowClosed: true
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    const result = await handleInterviewReminderResponse(prisma, candidateId, candidateText, { now });
    assert.equal(result.status, expectedStatus);
    if (expectedIntent) assert.equal(result.intent, expectedIntent);
    assert.equal(prisma.state.interviewBookings[0].status, expectedStatus);
    assert.equal(prisma.state.interviewBookings[0].reminderResponse, candidateText);
    assert.equal(whatsappMock.sentMessages.length, 0);
  } finally {
    restoreAxios();
    delete process.env.ADMIN_WHATSAPP_NUMBER;
  }
}

test('respuesta afirmativa cambia entrevista a CONFIRMED sin enviar WhatsApp', async () => {
  await assertReminderTransition({
    candidateText: 'Sí, confirmo mi asistencia',
    expectedStatus: 'CONFIRMED'
  });
});

test('respuesta de cancelación cambia entrevista a CANCELLED sin enviar WhatsApp', async () => {
  await assertReminderTransition({
    candidateText: 'No puedo asistir, cancela por favor',
    expectedStatus: 'CANCELLED'
  });
});

test('respuesta de reprogramación conserva reserva activa y clasifica intención', async () => {
  await assertReminderTransition({
    candidateText: 'Necesito reprogramar la entrevista',
    expectedStatus: 'SCHEDULED',
    expectedIntent: 'reschedule_interview'
  });
});

test('la localidad embebida exige una única coincidencia canónica', () => {
  assert.equal(normalizeBogotaLocalidad('Suba Sector Prueba'), 'Suba');
  assert.equal(normalizeBogotaLocalidad('Suba o Engativá'), null);
  assert.equal(normalizeBogotaLocalidad('Bogotá Sector Prueba'), null);
});
