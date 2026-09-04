import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInterviewAdminAuditEvents } from '../src/routes/interviewOutreachManagement.js';

const routeSource = readFileSync(new URL('../src/routes/interviewOutreachManagement.js', import.meta.url), 'utf8');
const detailSource = readFileSync(new URL('../src/views/detail.ejs', import.meta.url), 'utf8');

function snapshot({
  invitation = 'PENDING',
  attendance = 'PENDING',
  rating = null,
  observationEnabled = false,
  observation = null,
  complementaryFields = []
} = {}) {
  return {
    invitation: { status: invitation },
    attendance: { status: attendance },
    evaluation: { rating, observationEnabled, observation },
    complementaryFields
  };
}

test('DEV recibe el movimiento Confirmó entrevista y No interesado con valores legibles', () => {
  const confirmed = buildInterviewAdminAuditEvents({
    action: 'coordination',
    beforeSnapshot: snapshot({ invitation: 'PENDING' }),
    afterSnapshot: snapshot({ invitation: 'CONFIRMED' }),
    afterBooking: { scheduledAt: new Date('2026-09-10T20:00:00.000Z') }
  });

  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].eventType, 'INTERVIEW_INVITATION_STATUS_CHANGED');
  assert.equal(confirmed[0].eventLabel, 'Actualizó gestión de entrevista');
  assert.equal(confirmed[0].fromValue, 'Pendiente de respuesta');
  assert.equal(confirmed[0].toValue, 'Confirmó entrevista');
  assert.match(confirmed[0].note, /^Horario: /);

  const declined = buildInterviewAdminAuditEvents({
    action: 'coordination',
    beforeSnapshot: snapshot({ invitation: 'CONFIRMED' }),
    afterSnapshot: snapshot({ invitation: 'DECLINED' })
  });

  assert.deepEqual(declined, [{
    eventType: 'INTERVIEW_INVITATION_STATUS_CHANGED',
    eventLabel: 'Actualizó gestión de entrevista',
    fromValue: 'Confirmó entrevista',
    toValue: 'No interesado',
    note: null
  }]);
});

test('reprogramar manualmente una entrevista confirmada queda como movimiento separado', () => {
  const events = buildInterviewAdminAuditEvents({
    action: 'coordination',
    beforeSnapshot: snapshot({ invitation: 'CONFIRMED' }),
    afterSnapshot: snapshot({ invitation: 'CONFIRMED' }),
    beforeBooking: { scheduledAt: new Date('2026-09-10T20:00:00.000Z') },
    afterBooking: { scheduledAt: new Date('2026-09-11T20:00:00.000Z') }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'INTERVIEW_SCHEDULE_CHANGED');
  assert.equal(events[0].eventLabel, 'Actualizó fecha de entrevista');
  assert.notEqual(events[0].fromValue, events[0].toValue);
});

test('asistencia registra únicamente una transición real', () => {
  const attended = buildInterviewAdminAuditEvents({
    action: 'attendance',
    beforeSnapshot: snapshot({ attendance: 'PENDING' }),
    afterSnapshot: snapshot({ attendance: 'ATTENDED' })
  });
  assert.deepEqual(attended, [{
    eventType: 'INTERVIEW_ATTENDANCE_STATUS_CHANGED',
    eventLabel: 'Actualizó asistencia de entrevista',
    fromValue: 'Pendiente',
    toValue: 'Asistió',
    note: null
  }]);

  assert.deepEqual(buildInterviewAdminAuditEvents({
    action: 'attendance',
    beforeSnapshot: snapshot({ attendance: 'ATTENDED' }),
    afterSnapshot: snapshot({ attendance: 'ATTENDED' })
  }), []);
});

test('evaluación deja trazabilidad sin copiar observación ni valor complementario al evento', () => {
  const events = buildInterviewAdminAuditEvents({
    action: 'evaluation',
    beforeSnapshot: snapshot({
      rating: 4,
      observationEnabled: true,
      observation: 'texto-seudonimizado-anterior',
      complementaryFields: [{ id: 'field-test-1', label: 'Disponibilidad', value: 'valor-seudonimizado-anterior' }]
    }),
    afterSnapshot: snapshot({
      rating: 4,
      observationEnabled: true,
      observation: 'texto-seudonimizado-nuevo',
      complementaryFields: [{ id: 'field-test-1', label: 'Disponibilidad', value: 'valor-seudonimizado-nuevo' }]
    })
  });

  assert.deepEqual(events, [{
    eventType: 'INTERVIEW_EVALUATION_UPDATED',
    eventLabel: 'Actualizó evaluación de entrevista',
    fromValue: null,
    toValue: null,
    note: 'Actualizó observación o información complementaria.'
  }]);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /texto-seudonimizado/);
  assert.doesNotMatch(serialized, /valor-seudonimizado/);
});

test('cambio de calificación muestra solo la nota anterior y nueva', () => {
  const events = buildInterviewAdminAuditEvents({
    action: 'evaluation',
    beforeSnapshot: snapshot({ rating: 3.5 }),
    afterSnapshot: snapshot({ rating: 4.25 })
  });

  assert.deepEqual(events, [{
    eventType: 'INTERVIEW_EVALUATION_UPDATED',
    eventLabel: 'Actualizó evaluación de entrevista',
    fromValue: '3,50',
    toValue: '4,25',
    note: null
  }]);
});

test('solo la creación real de un campo complementario genera movimiento', () => {
  assert.deepEqual(buildInterviewAdminAuditEvents({
    action: 'complementary-field',
    complementaryField: { created: false, label: 'Disponibilidad' }
  }), []);

  assert.deepEqual(buildInterviewAdminAuditEvents({
    action: 'complementary-field',
    complementaryField: { created: true, label: 'Disponibilidad' }
  }), [{
    eventType: 'INTERVIEW_COMPLEMENTARY_FIELD_CREATED',
    eventLabel: 'Creó campo complementario de entrevista',
    fromValue: null,
    toValue: 'Disponibilidad',
    note: null
  }]);
});

test('la ruta reutiliza CandidateAdminEvent como bitácora y la vista continúa restringida a DEV', () => {
  assert.match(routeSource, /prisma\.candidateAdminEvent\.create\(/);
  assert.match(routeSource, /actorUserId:\s*normalizeString\(actor\?\.userId\)/);
  assert.match(routeSource, /actorRole/);
  assert.match(routeSource, /buildInterviewAdminAuditEvents\(\{/);
  assert.match(routeSource, /action: 'coordination'/);
  assert.match(routeSource, /action: 'attendance'/);
  assert.match(routeSource, /action: 'evaluation'/);
  assert.match(routeSource, /action: 'complementary-field'/);
  assert.doesNotMatch(routeSource, /prisma\.candidate\.(?:update|updateMany|upsert|create)\s*\(/);

  assert.match(detailSource, /if \(role === 'dev'\)/);
  assert.match(detailSource, /Movimientos del reclutador/);
  assert.match(detailSource, /adminEvents/);
});
