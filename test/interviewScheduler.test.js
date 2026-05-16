import test from 'node:test';
import assert from 'node:assert/strict';
import { getInterviewReminderAt, listOfferableSlots } from '../src/services/interviewScheduler.js';

function buildPrismaWithSlots(slots) {
  return {
    interviewSlot: {
      async findMany() {
        return slots;
      }
    }
  };
}

test('listOfferableSlots mantiene regla de 6 horas por defecto para el bot', async () => {
  const now = new Date('2026-04-15T15:00:00.000Z'); // 10:00 a.m. Colombia
  const prisma = buildPrismaWithSlots([
    {
      id: 'slot-hoy',
      vacancyId: 'vac-1',
      isActive: true,
      dayOfWeek: null,
      specificDate: '2026-04-15T05:00:00.000Z',
      startTime: '12:00',
      maxCandidates: 3,
      bookings: []
    }
  ]);

  const offers = await listOfferableSlots(prisma, 'vac-1', null, now);
  assert.equal(offers.length, 0);
});

test('listOfferableSlots permite horario del mismo dia cuando es asignacion manual dev', async () => {
  const now = new Date('2026-04-15T15:00:00.000Z'); // 10:00 a.m. Colombia
  const prisma = buildPrismaWithSlots([
    {
      id: 'slot-hoy',
      vacancyId: 'vac-1',
      isActive: true,
      dayOfWeek: null,
      specificDate: '2026-04-15T05:00:00.000Z',
      startTime: '12:00',
      maxCandidates: 3,
      bookings: []
    }
  ]);

  const offers = await listOfferableSlots(prisma, 'vac-1', null, now, 0);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].slot.id, 'slot-hoy');
});


test('getInterviewReminderAt calcula recordatorio 40 minutos antes de la entrevista', () => {
  const interviewDate = new Date('2026-04-08T22:00:00.000Z');
  assert.equal(getInterviewReminderAt(interviewDate).toISOString(), '2026-04-08T21:20:00.000Z');
});
