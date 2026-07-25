import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLocalInterviewIntent,
  detectInterviewIntent
} from '../src/services/interviewLifecycle.js';
import { classifyInterviewIntent } from '../src/services/interviewIntentClassifier.js';

const previousDay = new Date('2026-04-23T18:00:00.000Z');
const sameDay = new Date('2026-04-24T13:00:00.000Z');

const activeBooking = Object.freeze({
  id: 'booking-policy-matrix',
  status: 'SCHEDULED',
  scheduledAt: new Date('2026-04-24T18:00:00.000Z'),
  reminderSentAt: null,
  reminderWindowClosed: false
});

function bookingWithReminder() {
  return {
    ...activeBooking,
    reminderSentAt: new Date('2026-04-24T17:20:00.000Z')
  };
}

function createParser(result = { intent: 'unknown', parsedFields: {} }) {
  const calls = [];
  return {
    calls,
    parseIntent: async (text, options) => {
      calls.push({ text, options });
      return result;
    }
  };
}

const zeroCostScenarios = [
  {
    name: 'cancelación explícita antes del recordatorio',
    text: 'Quiero cancelar la entrevista',
    booking: activeBooking,
    now: previousDay,
    expected: 'cancel_interview'
  },
  {
    name: 'cancelación con futuro verbal antes del recordatorio',
    text: 'No podré ir a la entrevista',
    booking: activeBooking,
    now: previousDay,
    expected: 'cancel_interview'
  },
  {
    name: 'reprogramación explícita antes del recordatorio',
    text: 'Necesito reagendar, dame otro horario',
    booking: activeBooking,
    now: previousDay,
    expected: 'reschedule_interview'
  },
  {
    name: 'dificultad con alternativa antes del recordatorio',
    text: 'Se me complicó, ¿puedo ir mañana?',
    booking: activeBooking,
    now: previousDay,
    expected: 'reschedule_interview'
  },
  {
    name: 'alternativa prevalece sobre imposibilidad general',
    text: 'No puedo ir, ¿hay otra hora?',
    booking: activeBooking,
    now: previousDay,
    expected: 'reschedule_interview'
  },
  {
    name: 'tardanza explícita conserva reprogramación',
    text: 'Voy tarde y no llego a tiempo',
    booking: activeBooking,
    now: sameDay,
    expected: 'reschedule_interview'
  },
  {
    name: 'cambio de dato personal no altera la cita',
    text: 'Necesito cambiar mi número de contacto',
    booking: activeBooking,
    now: previousDay,
    expected: 'none'
  },
  {
    name: 'confirmación fuerte el mismo día',
    text: 'Sí voy, confirmo asistencia',
    booking: activeBooking,
    now: sameDay,
    expected: 'confirm_attendance'
  },
  {
    name: 'confirmación breve fuera de recordatorio',
    text: 'sí',
    booking: activeBooking,
    now: previousDay,
    expected: 'none'
  },
  {
    name: 'confirmación breve dentro del recordatorio',
    text: 'sí',
    booking: bookingWithReminder(),
    now: sameDay,
    expected: 'confirm_attendance'
  },
  {
    name: 'pregunta logística dentro del recordatorio',
    text: '¿Dónde queda y qué documentos llevo?',
    booking: bookingWithReminder(),
    now: sameDay,
    expected: 'none',
    expectedSource: 'semantic_local_logistics'
  },
  {
    name: 'booking cerrado nunca clasifica',
    text: 'No puedo ir, ¿hay otra hora?',
    booking: { ...activeBooking, status: 'CANCELLED' },
    now: sameDay,
    expected: 'none'
  }
];

for (const scenario of zeroCostScenarios) {
  test(`matriz local: ${scenario.name}`, async () => {
    const parser = createParser();
    const deterministic = detectInterviewIntent(scenario);
    const enriched = await classifyInterviewIntent({
      ...scenario,
      parseIntent: parser.parseIntent
    });

    assert.equal(deterministic, scenario.expected);
    assert.equal(enriched.intent, scenario.expected);
    assert.equal(parser.calls.length, 0, 'Un escenario resuelto localmente no debe escalar al parser.');
    if (scenario.expectedSource) assert.equal(enriched.source, scenario.expectedSource);
  });
}

test('la política local expone evidencia estable para el conflicto cancelación/reprogramación', () => {
  const local = classifyLocalInterviewIntent('No puedo ir, ¿hay otra hora?');
  assert.equal(local.intent, 'reschedule_interview');
  assert.equal(local.source, 'semantic_local');
  assert.ok(local.confidence >= 0.8);
});

test('solo una ambigüedad dentro del recordatorio escala una vez al parser enriquecido', async () => {
  const parser = createParser({
    intent: 'unknown',
    parsedFields: { reason: 'Necesito otra hora' }
  });
  const booking = bookingWithReminder();
  const text = '¿Podemos revisar lo de la entrevista?';

  assert.equal(detectInterviewIntent({ text, booking, now: sameDay }), 'none');

  const result = await classifyInterviewIntent({
    text,
    booking,
    now: sameDay,
    parseIntent: parser.parseIntent
  });

  assert.equal(result.intent, 'reschedule_interview');
  assert.equal(result.source, 'openai_recruitment_fields');
  assert.equal(parser.calls.length, 1);
  assert.equal(parser.calls[0].options.mode, 'interview_reminder_intent');
});
