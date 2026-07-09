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

test('listOfferableSlots no agenda dias semanales en la proxima semana cuando el slot es solo semana en curso', async () => {
  const now = new Date('2026-04-16T15:00:00.000Z'); // jueves 10:00 a.m. Colombia
  const prisma = buildPrismaWithSlots([
    {
      id: 'slot-lunes-solo-semana-actual',
      vacancyId: 'vac-1',
      isActive: true,
      dayOfWeek: 0,
      specificDate: null,
      startTime: '08:00',
      maxCandidates: 3,
      currentWeekOnly: true,
      bookings: []
    }
  ]);

  const offers = await listOfferableSlots(prisma, 'vac-1', null, now);
  assert.equal(offers.length, 0);
});

test('listOfferableSlots conserva recurrencia semanal cuando semana en curso esta desactivado', async () => {
  const now = new Date('2026-04-16T15:00:00.000Z'); // jueves 10:00 a.m. Colombia
  const prisma = buildPrismaWithSlots([
    {
      id: 'slot-lunes-recurrente',
      vacancyId: 'vac-1',
      isActive: true,
      dayOfWeek: 0,
      specificDate: null,
      startTime: '08:00',
      maxCandidates: 3,
      currentWeekOnly: false,
      bookings: []
    }
  ]);

  const offers = await listOfferableSlots(prisma, 'vac-1', null, now);
  assert.equal(offers.length, 4);
  assert.equal(offers[0].slot.id, 'slot-lunes-recurrente');
  assert.equal(offers[0].date.toISOString(), '2026-04-20T13:00:00.000Z');
});

test('listOfferableSlots permite dias futuros dentro de la semana en curso cuando el boton esta activo', async () => {
  const now = new Date('2026-04-16T15:00:00.000Z'); // jueves 10:00 a.m. Colombia
  const prisma = buildPrismaWithSlots([
    {
      id: 'slot-viernes-semana-actual',
      vacancyId: 'vac-1',
      isActive: true,
      dayOfWeek: 4,
      specificDate: null,
      startTime: '08:00',
      maxCandidates: 3,
      currentWeekOnly: true,
      bookings: []
    }
  ]);

  const offers = await listOfferableSlots(prisma, 'vac-1', null, now);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].slot.id, 'slot-viernes-semana-actual');
  assert.equal(offers[0].date.toISOString(), '2026-04-17T13:00:00.000Z');
});


test('getInterviewReminderAt calcula recordatorio 1 hora antes de entrevista de 10:00 a.m. Colombia', () => {
  const interviewDate = new Date('2026-04-08T15:00:00.000Z'); // 10:00 a.m. Colombia
  assert.equal(getInterviewReminderAt(interviewDate).toISOString(), '2026-04-08T14:00:00.000Z'); // 9:00 a.m. Colombia
});
