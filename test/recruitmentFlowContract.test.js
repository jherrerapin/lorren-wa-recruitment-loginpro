import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { listOfferableSlots } from '../src/services/interviewScheduler.js';
import { isSchedulingOfferDecline } from '../src/services/interviewLifecycle.js';
import { buildReminderText } from '../src/services/reminder.js';

test('agenda exige más de seis horas de anticipación y excluye exactamente seis horas', async () => {
  const now = new Date('2026-04-08T10:00:00.000Z'); // 5:00 a.m. Colombia
  const prisma = {
    interviewSlot: {
      findMany: async () => [
        {
          id: 'exact-six',
          specificDate: new Date('2026-04-08T12:00:00.000Z'),
          startTime: '11:00',
          currentWeekOnly: false,
          maxCandidates: 10,
          bookings: []
        },
        {
          id: 'over-six',
          specificDate: new Date('2026-04-08T12:00:00.000Z'),
          startTime: '11:01',
          currentWeekOnly: false,
          maxCandidates: 10,
          bookings: []
        }
      ]
    }
  };

  const offers = await listOfferableSlots(prisma, 'vacancy', now, now);
  assert.deepEqual(offers.map((offer) => offer.slot.id), ['over-six']);
});

test('un no breve rechaza el horario solo dentro del contexto de oferta de entrevista', () => {
  assert.equal(isSchedulingOfferDecline('No'), true);
  assert.equal(isSchedulingOfferDecline('No gracias'), true);
  assert.equal(isSchedulingOfferDecline('No me sirve'), true);
  assert.equal(isSchedulingOfferDecline('¿Me puedes dar otro horario?'), true);
  assert.equal(isSchedulingOfferDecline('Necesito reprogramar'), true);
  assert.equal(isSchedulingOfferDecline('No', { allowShortNo: false }), false);
  assert.equal(isSchedulingOfferDecline('Necesito reprogramar', { allowShortNo: false }), true);
  assert.equal(isSchedulingOfferDecline('Sí, me sirve'), false);
  assert.equal(isSchedulingOfferDecline('¿Cuál es la dirección?'), false);
});

test('el no breve queda acotado a una oferta pendiente y no a una entrevista ya agendada', () => {
  const source = fs.readFileSync('src/routes/webhook.js', 'utf8');
  assert.match(source, /isSchedulingOfferDecline\(text, \{ allowShortNo: false \}\)/);
  assert.match(source, /if \(pendingOffer\) \{\s+if \(wantsAlternative \|\| isSchedulingOfferDecline\(inboundText\)\)/);
});

test('recordatorio de proceso nombra la confirmación de entrevista cuando datos y HV ya están completos', () => {
  const text = buildReminderText({
    fullName: 'Persona Ejemplo',
    documentType: 'CC',
    documentNumber: '1000000000',
    age: 28,
    neighborhood: 'Centro',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    cvData: {},
    currentStep: 'SCHEDULING',
    vacancy: { city: 'Ibague', experienceRequired: 'NO' }
  });

  assert.match(text, /proceso sigue activo/i);
  assert.match(text, /solo falta definir y confirmar el horario de tu entrevista/i);
});

test('el prompt principal usa tuteo colombiano y criterio senior, no apertura en voseo', () => {
  const source = fs.readFileSync('src/services/conversationEngine.js', 'utf8');
  assert.match(source, /Eres \$\{LORREN_ROLE_LABEL\} atendiendo candidatos por WhatsApp/);
  assert.match(source, /Usa tuteo colombiano natural y evita el voseo/);
  assert.match(source, /criterio de reclutadora senior/);
  assert.doesNotMatch(source, /Sos \$\{LORREN_ROLE_LABEL\}/);
});

test('la documentación conversacional coincide con el recordatorio operativo de una hora', () => {
  const principles = fs.readFileSync('docs/conversational-ai-principles.md', 'utf8');
  assert.match(principles, /recordatorio de entrevista se envía 1 hora antes/);
  assert.doesNotMatch(principles, /recordatorio de entrevista se envía 40 minutos antes/);
});
