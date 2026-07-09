import test from 'node:test';
import assert from 'node:assert/strict';
import { canScheduleReminderPolicy, isWithinWhatsappWindow } from '../src/services/reminderPolicy.js';
import { buildReminderText, handleInterviewReminderResponse, runInterviewReminderDispatcher, runReminderDispatcher } from '../src/services/reminder.js';
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

test('buildReminderText especifica exactamente los campos faltantes y la HV cuando aplica', () => {
  const text = buildReminderText({
    fullName: 'Persona Ejemplo',
    documentType: 'CC',
    documentNumber: 'DOC-TEST-001',
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


test('buildReminderText incluye experiencia cuando la vacante la exige', () => {
  const text = buildReminderText({
    fullName: 'Candidata Prueba',
    documentType: 'CC',
    documentNumber: 'DOC-TEST-002',
    age: 29,
    locality: 'Suba',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    cvData: {},
    experienceInfo: null,
    experienceTime: null,
    vacancy: {
      city: 'Bogota',
      experienceRequired: 'YES',
      experienceTimeText: 'mínimo 6 meses'
    }
  });

  assert.match(text, /experiencia/i);
  assert.match(text, /tiempo de experiencia/i);
  assert.match(text, /mínimo 6 meses/i);
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
    assert.doesNotMatch(whatsappMock.sentMessages[0].body, /datos faltantes/i);
    assert.equal(prisma.state.candidates[0].reminderState, 'SENT');
  } finally {
    restoreAxios();
  }
});
test('recordatorio de entrevista se envía 1 hora antes de entrevista de 10:00 a.m. Colombia y marca reminderSentAt', async () => {
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
    assert.match(whatsappMock.sentMessages[0].body, /Auxiliar de bodega/);
    assert.match(whatsappMock.sentMessages[0].body, /Auxiliar de bodega Fontibon/);
    assert.match(whatsappMock.sentMessages[0].body, /Calle 80 # 12-34/);
    assert.doesNotMatch(whatsappMock.sentMessages[0].body, /hoja de vida|datos/i);
    assert.equal(prisma.state.interviewBookings[0].reminderSentAt.toISOString(), now.toISOString());
  } finally {
    restoreAxios();
  }
});
test('recordatorio de entrevista no se duplica si ya fue enviado 1 hora antes', async () => {
  setupWhatsappEnv();
  const now = new Date('2026-04-08T14:01:00.000Z'); // 9:01 a.m. Colombia
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-interview-reminder-forty-before',
      phone: '570000000003',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T13:50:00.000Z'),
      botPaused: false
    }],
    interviewBookings: [{
      id: 'booking-reminder-forty-before',
      candidateId: 'cand-interview-reminder-forty-before',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date(INTERVIEW_10_AM_CO),
      status: 'SCHEDULED',
      reminderSentAt: new Date(REMINDER_9_00_AM_CO),
      reminderWindowClosed: true
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });
  try {
    await runReminderDispatcher(prisma, { now });
    assert.equal(whatsappMock.sentMessages.length, 0);
    assert.equal(prisma.state.interviewBookings[0].reminderSentAt.toISOString(), REMINDER_9_00_AM_CO);
  } finally {
    restoreAxios();
  }
});

test('booking pasa a NO_RESPONSE faltando 5 minutos si no hubo respuesta al reminder', async () => {
  setupWhatsappEnv();
  const now = new Date('2026-04-08T14:55:00.000Z'); // 9:55 a.m. Colombia
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-no-response',
      phone: '570000000004',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T13:30:00.000Z'),
      botPaused: false
    }],
    interviewBookings: [{
      id: 'booking-no-response',
      candidateId: 'cand-no-response',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date(INTERVIEW_10_AM_CO),
      status: 'SCHEDULED',
      reminderSentAt: new Date(REMINDER_9_00_AM_CO),
      reminderWindowClosed: true
    }],
    vacancies: [{ id: 'vac', isActive: true, schedulingEnabled: true }],
    messages: [{
      id: 'msg-reminder',
      candidateId: 'cand-no-response',
      direction: 'OUTBOUND',
      body: 'recordatorio entrevista',
      createdAt: new Date(REMINDER_9_00_AM_CO),
      rawPayload: { source: 'interview_booking_reminder' }
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });
  try {
    await runInterviewReminderDispatcher(prisma, { now, candidateId: 'cand-no-response' });
    assert.equal(prisma.state.interviewBookings[0].status, 'NO_RESPONSE');
    assert.equal(whatsappMock.sentMessages.length, 1);
    assert.match(whatsappMock.sentMessages[0].body, /tu entrevista es en 5 minutos/i);
  } finally {
    restoreAxios();
  }
});

async function assertReminderTransition({ candidateText, expectedStatus }) {
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
    assert.equal(prisma.state.interviewBookings[0].status, expectedStatus);
    assert.equal(prisma.state.interviewBookings[0].reminderResponse, candidateText);
    assert.equal(whatsappMock.sentMessages.length, 0);
  } finally {
    restoreAxios();
    delete process.env.ADMIN_WHATSAPP_NUMBER;
  }
}

test('respuesta afirmativa al recordatorio cambia entrevista a CONFIRMED sin enviar WhatsApp', async () => {
  await assertReminderTransition({
    candidateText: 'Sí, confirmo mi asistencia',
    expectedStatus: 'CONFIRMED'
  });
});

test('respuesta de cancelación al recordatorio cambia entrevista a CANCELLED sin enviar WhatsApp', async () => {
  await assertReminderTransition({
    candidateText: 'No puedo asistir hoy',
    expectedStatus: 'CANCELLED'
  });
});

test('respuesta de reprogramación al recordatorio cambia entrevista a RESCHEDULED sin enviar WhatsApp', async () => {
  await assertReminderTransition({
    candidateText: 'Necesito reprogramar la entrevista',
    expectedStatus: 'RESCHEDULED'
  });
});

test('scheduleReminderForCandidate agenda recordatorio 2 horas después del último outbound relevante', async () => {
  const { scheduleReminderForCandidate, CANDIDATE_PROCESS_REMINDER_DELAY_MS } = await import('../src/services/reminder.js');
  const lastOutboundAt = new Date('2026-04-07T18:10:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-process-anchor',
      phone: '570000000010',
      status: 'NUEVO',
      currentStep: 'ASK_CV',
      reminderState: 'NONE',
      reminderScheduledFor: null,
      lastInboundAt: new Date('2026-04-07T18:00:00.000Z'),
      lastOutboundAt,
      fullName: 'Persona Ejemplo'
    }]
  });

  await scheduleReminderForCandidate(prisma, 'cand-process-anchor', new Date('2026-04-07T18:30:00.000Z'));

  assert.equal(
    prisma.state.candidates[0].reminderScheduledFor.toISOString(),
    new Date(lastOutboundAt.getTime() + CANDIDATE_PROCESS_REMINDER_DELAY_MS).toISOString()
  );
});

test('booking CONFIRMED no es pisado por NO_RESPONSE faltando 5 minutos', async () => {
  setupWhatsappEnv();
  const now = new Date('2026-04-08T14:55:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{ id: 'cand-confirmed-safe', phone: '570000000011', status: 'REGISTRADO', currentStep: 'SCHEDULED', lastInboundAt: new Date('2026-04-08T13:30:00.000Z'), botPaused: false }],
    interviewBookings: [{
      id: 'booking-confirmed-safe', candidateId: 'cand-confirmed-safe', vacancyId: 'vac', slotId: 'slot',
      scheduledAt: new Date(INTERVIEW_10_AM_CO), status: 'CONFIRMED', reminderSentAt: new Date(REMINDER_9_00_AM_CO), reminderWindowClosed: true
    }],
    vacancies: [{ id: 'vac', isActive: true, schedulingEnabled: true }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });
  try {
    await runInterviewReminderDispatcher(prisma, { now, candidateId: 'cand-confirmed-safe' });
    assert.equal(prisma.state.interviewBookings[0].status, 'CONFIRMED');
    assert.equal(whatsappMock.sentMessages.length, 0);
  } finally { restoreAxios(); }
});
