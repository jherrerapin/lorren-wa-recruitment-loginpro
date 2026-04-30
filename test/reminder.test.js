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


test('buildReminderText incluye experiencia cuando la vacante la exige', () => {
  const text = buildReminderText({
    fullName: 'Laura Gomez',
    documentType: 'CC',
    documentNumber: '123456789',
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

test('canScheduleReminder permite paso SCHEDULING cuando no hay entrevista agendada', () => {
  const candidate = {
    status: 'REGISTRADO',
    currentStep: 'SCHEDULING',
    reminderState: 'NONE',
    lastInboundAt: new Date(),
    botPaused: false
  };

  assert.equal(canScheduleReminderPolicy(candidate), true);
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

test('runReminderDispatcher envia keepalive de entrevista antes de que venza la ventana cuando hay booking activo', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';

  const now = new Date('2026-04-08T21:00:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-interview-1',
      phone: '573009998877',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      reminderScheduledFor: null,
      lastInboundAt: new Date('2026-04-07T22:30:00.000Z'),
      lastOutboundAt: new Date('2026-04-07T22:35:00.000Z'),
      botPaused: false
    }],
    interviewBookings: [{
      id: 'booking-keepalive-1',
      candidateId: 'cand-interview-1',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date('2026-04-08T23:00:00.000Z'),
      status: 'SCHEDULED',
      reminderSentAt: null,
      reminderWindowClosed: false
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    await runReminderDispatcher(prisma, { now });
    assert.equal(whatsappMock.sentMessages.length, 1);
    assert.match(whatsappMock.sentMessages[0].body, /entrevista|horario|proceso activo/i);
    assert.equal(prisma.state.messages.at(-1)?.rawPayload?.source, 'interview_window_keepalive');
    assert.equal(prisma.state.candidates[0].lastOutboundAt.toISOString(), now.toISOString());

    await runReminderDispatcher(prisma, { now: new Date('2026-04-08T21:10:00.000Z') });
    assert.equal(whatsappMock.sentMessages.length, 1);
  } finally {
    restoreAxios();
  }
});

test('keepalive se corta cuando la entrevista ya pasó', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';

  const now = new Date('2026-04-08T21:00:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-interview-past',
      phone: '573000000000',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T20:00:00.000Z'),
      botPaused: false
    }],
    interviewBookings: [{
      id: 'booking-past',
      candidateId: 'cand-interview-past',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date('2026-04-08T20:30:00.000Z'),
      status: 'SCHEDULED',
      reminderSentAt: null,
      reminderWindowClosed: false
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    await runReminderDispatcher(prisma, { now });
    assert.equal(whatsappMock.sentMessages.length, 0);
  } finally {
    restoreAxios();
  }
});

test('keepalive no corre si booking está inactivo o ventana cerrada por reminder', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';

  const now = new Date('2026-04-08T21:00:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-interview-closed-status',
      phone: '573000000001',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T20:00:00.000Z'),
      botPaused: false
    }, {
      id: 'cand-interview-window-closed',
      phone: '573000000002',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T20:00:00.000Z'),
      botPaused: false
    }],
    interviewBookings: [{
      id: 'booking-closed-status',
      candidateId: 'cand-interview-closed-status',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date('2026-04-08T23:00:00.000Z'),
      status: 'CANCELLED',
      reminderSentAt: null,
      reminderWindowClosed: false
    }, {
      id: 'booking-window-closed',
      candidateId: 'cand-interview-window-closed',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date('2026-04-08T23:00:00.000Z'),
      status: 'SCHEDULED',
      reminderSentAt: null,
      reminderWindowClosed: true
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    await runReminderDispatcher(prisma, { now });
    assert.equal(whatsappMock.sentMessages.length, 0);
  } finally {
    restoreAxios();
  }
});

test('keepalive no corre para SCHEDULING sin booking real', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
  const now = new Date('2026-04-08T21:00:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-without-booking',
      phone: '573099999999',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULING',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-07T22:30:00.000Z'),
      botPaused: false
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });
  try {
    await runReminderDispatcher(prisma, { now });
    assert.equal(whatsappMock.sentMessages.length, 0);
  } finally {
    restoreAxios();
  }
});

test('recordatorio de entrevista se envía una hora antes y marca reminderSentAt', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
  const now = new Date('2026-04-08T21:00:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-interview-reminder',
      phone: '573088888888',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T19:50:00.000Z'),
      botPaused: false
    }],
    interviewBookings: [{
      id: 'booking-reminder',
      candidateId: 'cand-interview-reminder',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date('2026-04-08T22:00:00.000Z'),
      status: 'SCHEDULED',
      reminderSentAt: null,
      reminderWindowClosed: false
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });
  try {
    await runReminderDispatcher(prisma, { now });
    assert.equal(whatsappMock.sentMessages.length, 1);
    assert.match(whatsappMock.sentMessages[0].body, /recordarte tu entrevista/i);
    assert.doesNotMatch(whatsappMock.sentMessages[0].body, /hoja de vida|datos/i);
    assert.equal(prisma.state.interviewBookings[0].reminderSentAt.toISOString(), now.toISOString());
  } finally {
    restoreAxios();
  }
});

test('booking pasa a NO_RESPONSE a 10 minutos si no hubo respuesta al reminder', async () => {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
  const now = new Date('2026-04-08T21:50:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-no-response',
      phone: '573077777777',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T19:30:00.000Z'),
      botPaused: false
    }],
    interviewBookings: [{
      id: 'booking-no-response',
      candidateId: 'cand-no-response',
      vacancyId: 'vac',
      slotId: 'slot',
      scheduledAt: new Date('2026-04-08T22:00:00.000Z'),
      status: 'SCHEDULED',
      reminderSentAt: new Date('2026-04-08T21:00:00.000Z'),
      reminderWindowClosed: true
    }],
    messages: [{
      id: 'msg-reminder',
      candidateId: 'cand-no-response',
      direction: 'OUTBOUND',
      body: 'recordatorio entrevista',
      createdAt: new Date('2026-04-08T21:00:00.000Z'),
      rawPayload: { source: 'interview_booking_reminder' }
    }]
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });
  try {
    await runReminderDispatcher(prisma, { now });
    assert.equal(prisma.state.interviewBookings[0].status, 'NO_RESPONSE');
    assert.equal(whatsappMock.sentMessages.length, 0);
  } finally {
    restoreAxios();
  }
});
