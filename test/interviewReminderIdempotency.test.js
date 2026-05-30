import test from 'node:test';
import assert from 'node:assert/strict';
import { runReminderDispatcher } from '../src/services/reminder.js';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { installOpenAIMock } from './helpers/mockOpenAI.js';

function setupWhatsappEnv() {
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
}

test('recordatorio de entrevista es idempotente cuando existen bookings activos duplicados para el mismo candidato', async () => {
  setupWhatsappEnv();

  const now = new Date('2026-04-08T21:00:00.000Z');
  const prisma = createMockPrisma({
    candidates: [{
      id: 'cand-duplicate-bookings',
      phone: '573011112222',
      fullName: 'Carlos Perez',
      status: 'REGISTRADO',
      currentStep: 'SCHEDULED',
      reminderState: 'NONE',
      lastInboundAt: new Date('2026-04-08T19:50:00.000Z'),
      lastOutboundAt: null,
      botPaused: false,
      vacancyId: 'vac-duplicate-bookings'
    }],
    vacancies: [{
      id: 'vac-duplicate-bookings',
      title: 'Auxiliar logistico Montevideo',
      role: 'Auxiliar logistico',
      interviewAddress: 'Bodega Montevideo'
    }],
    interviewBookings: [{
      id: 'booking-duplicate-1',
      candidateId: 'cand-duplicate-bookings',
      vacancyId: 'vac-duplicate-bookings',
      slotId: 'slot-1',
      scheduledAt: new Date('2026-04-08T21:40:00.000Z'),
      status: 'SCHEDULED',
      reminderSentAt: null,
      reminderWindowClosed: false
    }, {
      id: 'booking-duplicate-2',
      candidateId: 'cand-duplicate-bookings',
      vacancyId: 'vac-duplicate-bookings',
      slotId: 'slot-2',
      scheduledAt: new Date('2026-04-08T21:42:00.000Z'),
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
    assert.match(whatsappMock.sentMessages[0].body, /te recuerdo que tienes entrevista|confirmas tu asistencia/i);

    const first = prisma.state.interviewBookings.find((booking) => booking.id === 'booking-duplicate-1');
    const second = prisma.state.interviewBookings.find((booking) => booking.id === 'booking-duplicate-2');

    assert.equal(first.reminderSentAt.toISOString(), now.toISOString());
    assert.equal(first.reminderWindowClosed, true);
    assert.equal(second.reminderSentAt, null);
    assert.equal(second.reminderWindowClosed, true);

    await runReminderDispatcher(prisma, { now });
    assert.equal(whatsappMock.sentMessages.length, 1);
  } finally {
    restoreAxios();
  }
});
