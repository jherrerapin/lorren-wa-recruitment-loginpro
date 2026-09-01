import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildInterviewManagementSnapshot,
  createInterviewComplementaryField,
  deriveInterviewRatingBand,
  normalizeInterviewRating,
  resolveEffectiveInvitationStatus,
  saveInterviewComplementaryValues,
  saveInterviewEvaluation,
  setInterviewAttendanceStatus,
  setInterviewInvitationStatus
} from '../src/services/interviewOutreachManagement.js';

function createPrismaMock() {
  const reviews = new Map();
  const fields = [];
  const values = new Map();
  let fieldSequence = 0;

  const reviewKey = (candidateId, vacancyId) => `${candidateId}:${vacancyId}`;
  const valueKey = (candidateId, fieldId) => `${candidateId}:${fieldId}`;

  const prisma = {
    interviewCandidateReview: {
      async upsert({ where, update, create }) {
        const { candidateId, vacancyId } = where.candidateId_vacancyId;
        const key = reviewKey(candidateId, vacancyId);
        const current = reviews.get(key);
        const next = current
          ? { ...current, ...update }
          : {
              id: `review-${reviews.size + 1}`,
              attendanceStatus: 'PENDING',
              observationEnabled: false,
              ...create
            };
        reviews.set(key, next);
        return structuredClone(next);
      }
    },
    interviewComplementaryField: {
      async findUnique({ where }) {
        const { vacancyId, normalizedLabel } = where.vacancyId_normalizedLabel;
        const found = fields.find((field) => (
          field.vacancyId === vacancyId && field.normalizedLabel === normalizedLabel
        ));
        return found ? structuredClone(found) : null;
      },
      async count({ where }) {
        return fields.filter((field) => field.vacancyId === where.vacancyId).length;
      },
      async upsert({ where, create }) {
        const { vacancyId, normalizedLabel } = where.vacancyId_normalizedLabel;
        let field = fields.find((item) => (
          item.vacancyId === vacancyId && item.normalizedLabel === normalizedLabel
        ));
        if (!field) {
          field = { id: `field-${++fieldSequence}`, ...create };
          fields.push(field);
        }
        return structuredClone(field);
      },
      async findMany({ where }) {
        const ids = new Set(where.id.in);
        return fields
          .filter((field) => field.vacancyId === where.vacancyId && ids.has(field.id))
          .map(({ id }) => ({ id }));
      }
    },
    interviewComplementaryValue: {
      async upsert({ where, update, create }) {
        const { candidateId, fieldId } = where.candidateId_fieldId;
        const key = valueKey(candidateId, fieldId);
        const current = values.get(key);
        const next = current
          ? { ...current, ...update, updatedAt: new Date('2026-09-01T02:30:00.000Z') }
          : {
              id: `value-${values.size + 1}`,
              ...create,
              createdAt: new Date('2026-09-01T02:30:00.000Z'),
              updatedAt: new Date('2026-09-01T02:30:00.000Z')
            };
        values.set(key, next);
        return structuredClone(next);
      }
    },
    async $transaction(input) {
      if (typeof input === 'function') return input(prisma);
      return Promise.all(input);
    }
  };

  return { prisma, reviews, fields, values };
}

const actor = { userId: 'user-test-1', label: 'Usuario Prueba' };

test('calificación decimal respeta los tres cortes definidos', () => {
  assert.equal(normalizeInterviewRating('3,50'), 3.5);
  assert.deepEqual(deriveInterviewRatingBand(1), { key: 'DISQUALIFIED', label: 'Descalificado' });
  assert.deepEqual(deriveInterviewRatingBand(2.99), { key: 'DISQUALIFIED', label: 'Descalificado' });
  assert.deepEqual(deriveInterviewRatingBand(3), { key: 'RESERVE', label: 'Reserva' });
  assert.deepEqual(deriveInterviewRatingBand(3.59), { key: 'RESERVE', label: 'Reserva' });
  assert.deepEqual(deriveInterviewRatingBand(3.6), { key: 'OPTIONED', label: 'Opcionado a contratar' });
  assert.deepEqual(deriveInterviewRatingBand(5), { key: 'OPTIONED', label: 'Opcionado a contratar' });
  assert.throws(() => normalizeInterviewRating(0.99), /interview_rating_out_of_range/);
  assert.throws(() => normalizeInterviewRating(5.01), /interview_rating_out_of_range/);
});

test('WhatsApp es el valor por defecto y la evidencia más reciente puede superar un override manual viejo', () => {
  const whatsappAt = new Date('2026-09-01T02:20:00.000Z');
  const manualAt = new Date('2026-09-01T02:10:00.000Z');
  const result = resolveEffectiveInvitationStatus({
    invitationStatusOverride: 'PENDING',
    invitationUpdatedAt: manualAt,
    invitationUpdatedByLabel: 'Usuario Prueba'
  }, {
    status: 'CONFIRMADO',
    respondedAt: whatsappAt
  });

  assert.deepEqual(result, {
    status: 'CONFIRMED',
    source: 'WHATSAPP',
    updatedAt: whatsappAt,
    updatedByLabel: null
  });
});

test('una gestión manual posterior puede registrar pendiente o no asistirá sin borrar la evidencia de WhatsApp', () => {
  const manualAt = new Date('2026-09-01T02:30:00.000Z');
  const result = resolveEffectiveInvitationStatus({
    invitationStatusOverride: 'DECLINED',
    invitationUpdatedAt: manualAt,
    invitationUpdatedByLabel: 'Usuario Prueba'
  }, {
    status: 'CONFIRMADO',
    respondedAt: new Date('2026-09-01T02:20:00.000Z')
  });

  assert.equal(result.status, 'DECLINED');
  assert.equal(result.source, 'MANUAL');
  assert.equal(result.updatedByLabel, 'Usuario Prueba');
});

test('confirmación previa y asistencia real se persisten como hechos independientes con actor interno', async () => {
  const { prisma, reviews } = createPrismaMock();
  const candidateId = 'candidate-test-a';
  const vacancyId = 'vacancy-test-a';

  await setInterviewInvitationStatus(prisma, {
    candidateId,
    vacancyId,
    status: 'CONFIRMED',
    actor,
    now: '2026-09-01T02:10:00.000Z'
  });
  await setInterviewAttendanceStatus(prisma, {
    candidateId,
    vacancyId,
    status: 'NO_SHOW',
    actor,
    now: '2026-09-01T04:10:00.000Z'
  });

  const stored = reviews.get(`${candidateId}:${vacancyId}`);
  assert.equal(stored.invitationStatusOverride, 'CONFIRMED');
  assert.equal(stored.attendanceStatus, 'NO_SHOW');
  assert.equal(stored.invitationUpdatedByUserId, actor.userId);
  assert.equal(stored.invitationUpdatedByLabel, actor.label);
  assert.equal(stored.attendanceUpdatedByUserId, actor.userId);
  assert.equal(stored.attendanceUpdatedByLabel, actor.label);
});

test('evaluación guarda decimal, observación opcional y trazabilidad sin cambiar estados de candidato', async () => {
  const { prisma, reviews } = createPrismaMock();
  const result = await saveInterviewEvaluation(prisma, {
    candidateId: 'candidate-test-b',
    vacancyId: 'vacancy-test-b',
    rating: '4.35',
    observationEnabled: true,
    observation: 'Observación seudonimizada de entrevista.',
    actor,
    now: '2026-09-01T03:00:00.000Z'
  });

  const stored = reviews.get('candidate-test-b:vacancy-test-b');
  assert.equal(stored.rating, 4.35);
  assert.equal(stored.observationEnabled, true);
  assert.equal(stored.observation, 'Observación seudonimizada de entrevista.');
  assert.equal(stored.reviewUpdatedByUserId, actor.userId);
  assert.equal(stored.reviewUpdatedByLabel, actor.label);
  assert.equal(result.ratingBand.key, 'OPTIONED');
  assert.equal(Object.hasOwn(stored, 'status'), false);
});

test('una etiqueta complementaria se crea una vez por vacante y cada candidato conserva su valor', async () => {
  const { prisma, fields, values } = createPrismaMock();
  const vacancyId = 'vacancy-test-c';

  const first = await createInterviewComplementaryField(prisma, {
    vacancyId,
    label: 'Disponibilidad de viaje',
    actor
  });
  const repeated = await createInterviewComplementaryField(prisma, {
    vacancyId,
    label: '  disponibilidad de VIAJE  ',
    actor
  });

  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(first.field.id, repeated.field.id);
  assert.equal(fields.length, 1);

  await saveInterviewComplementaryValues(prisma, {
    candidateId: 'candidate-test-c1',
    vacancyId,
    actor,
    values: [{ fieldId: first.field.id, value: 'Sí' }]
  });
  await saveInterviewComplementaryValues(prisma, {
    candidateId: 'candidate-test-c2',
    vacancyId,
    actor,
    values: [{ fieldId: first.field.id, value: 'No' }]
  });

  assert.equal(values.get(`candidate-test-c1:${first.field.id}`).value, 'Sí');
  assert.equal(values.get(`candidate-test-c2:${first.field.id}`).value, 'No');
  assert.equal(values.get(`candidate-test-c1:${first.field.id}`).updatedByLabel, actor.label);
});

test('snapshot conserva autoría y valores sin mezclar confirmación con asistencia', () => {
  const snapshot = buildInterviewManagementSnapshot({
    review: {
      invitationStatusOverride: 'CONFIRMED',
      invitationUpdatedAt: new Date('2026-09-01T02:10:00.000Z'),
      invitationUpdatedByLabel: 'Usuario Prueba',
      attendanceStatus: 'ATTENDED',
      attendanceUpdatedAt: new Date('2026-09-01T04:10:00.000Z'),
      attendanceUpdatedByLabel: 'Usuario Prueba',
      rating: '3.50',
      observationEnabled: false,
      reviewUpdatedAt: new Date('2026-09-01T04:20:00.000Z'),
      reviewUpdatedByLabel: 'Usuario Prueba'
    },
    evidence: { status: 'PENDIENTE', respondedAt: null },
    fields: [{ id: 'field-test', label: 'Campo Prueba', sortOrder: 0 }],
    values: [{
      fieldId: 'field-test',
      value: 'Valor Prueba',
      updatedAt: new Date('2026-09-01T04:30:00.000Z'),
      updatedByLabel: 'Usuario Prueba'
    }]
  });

  assert.equal(snapshot.invitation.status, 'CONFIRMED');
  assert.equal(snapshot.attendance.status, 'ATTENDED');
  assert.equal(snapshot.evaluation.band.key, 'RESERVE');
  assert.equal(snapshot.complementaryFields[0].value, 'Valor Prueba');
  assert.equal(snapshot.complementaryFields[0].updatedByLabel, 'Usuario Prueba');
});

test('la ruta toma el actor de sesión/AppUser y no acepta un nombre editable desde el body', () => {
  const source = readFileSync(new URL('../src/routes/interviewOutreachManagement.js', import.meta.url), 'utf8');
  assert.match(source, /req\.userId \|\| req\.session\?\.userId/);
  assert.match(source, /displayName:\s*true/);
  assert.match(source, /resolveCurrentActor\(prisma, req\)/);
  assert.doesNotMatch(source, /req\.body\??\.?actor|req\.body\??\.?updatedBy|req\.body\??\.?userId/);
  assert.match(source, /buildCandidateAccessWhere\(getRequestAccessContext\(req\)\)/);
});

test('la UI ofrece los cinco estados operativos, evaluación y + sin diálogos nativos', () => {
  const source = readFileSync(new URL('../src/public/interview-outreach-management.js', import.meta.url), 'utf8');
  for (const token of ['CONFIRMED', 'DECLINED', 'ATTENDED', 'NO_SHOW', 'Guardar evaluación', 'Agregar campo complementario']) {
    assert.match(source, new RegExp(token));
  }
  assert.doesNotMatch(source, /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(source, /actor\s*:/);
});

test('server monta la gestión antes del router administrativo sin tocar webhook', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const managementMount = source.indexOf("app.use('/admin', wrapAsyncRouter(interviewOutreachManagementRouter(prisma)))");
  const adminMount = source.indexOf("app.use('/admin', adminRouter(prisma))");
  assert.ok(managementMount >= 0);
  assert.ok(adminMount > managementMount);

  const webhookSource = readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  assert.doesNotMatch(webhookSource, /interviewOutreachManagement/);
});
