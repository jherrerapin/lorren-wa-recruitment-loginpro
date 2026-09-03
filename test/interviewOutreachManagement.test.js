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
        const found = fields.find((field) => field.vacancyId === vacancyId && field.normalizedLabel === normalizedLabel);
        return found ? structuredClone(found) : null;
      },
      async count({ where }) {
        return fields.filter((field) => field.vacancyId === where.vacancyId).length;
      },
      async upsert({ where, create }) {
        const { vacancyId, normalizedLabel } = where.vacancyId_normalizedLabel;
        let field = fields.find((item) => item.vacancyId === vacancyId && item.normalizedLabel === normalizedLabel);
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

test('calificación decimal respeta los cortes 2.99, 3.00, 3.59, 3.60 y 5.00', () => {
  assert.equal(normalizeInterviewRating('3,50'), 3.5);
  assert.deepEqual(deriveInterviewRatingBand(2.99), { key: 'DISQUALIFIED', label: 'Descalificado' });
  assert.deepEqual(deriveInterviewRatingBand(3), { key: 'RESERVE', label: 'Reserva' });
  assert.deepEqual(deriveInterviewRatingBand(3.59), { key: 'RESERVE', label: 'Reserva' });
  assert.deepEqual(deriveInterviewRatingBand(3.6), { key: 'OPTIONED', label: 'Opcionado a contratar' });
  assert.deepEqual(deriveInterviewRatingBand(5), { key: 'OPTIONED', label: 'Opcionado a contratar' });
  assert.throws(() => normalizeInterviewRating(0.99), /interview_rating_out_of_range/);
  assert.throws(() => normalizeInterviewRating(5.01), /interview_rating_out_of_range/);
});

test('la evidencia WhatsApp es el valor por defecto y gana si es posterior al override manual', () => {
  const whatsappAt = new Date('2026-09-01T02:20:00.000Z');
  const result = resolveEffectiveInvitationStatus({
    invitationStatusOverride: 'PENDING',
    invitationUpdatedAt: new Date('2026-09-01T02:10:00.000Z'),
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

test('una gestión manual posterior puede corregir confirmación sin borrar la evidencia automática', () => {
  const result = resolveEffectiveInvitationStatus({
    invitationStatusOverride: 'DECLINED',
    invitationUpdatedAt: new Date('2026-09-01T02:30:00.000Z'),
    invitationUpdatedByLabel: 'Usuario Prueba'
  }, {
    status: 'CONFIRMADO',
    respondedAt: new Date('2026-09-01T02:20:00.000Z')
  });

  assert.equal(result.status, 'DECLINED');
  assert.equal(result.source, 'MANUAL');
  assert.equal(result.updatedByLabel, 'Usuario Prueba');
});

test('confirmación previa y asistencia real son hechos persistidos independientes', async () => {
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
  assert.equal(stored.attendanceUpdatedByUserId, actor.userId);
});

test('evaluación guarda decimal y observación opcional con actor, sin escribir estado laboral', async () => {
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
  assert.equal(stored.reviewUpdatedByLabel, actor.label);
  assert.equal(result.ratingBand.key, 'OPTIONED');
  assert.equal(Object.hasOwn(stored, 'status'), false);
});

test('desactivar observación elimina el texto previo de la revisión', async () => {
  const { prisma, reviews } = createPrismaMock();
  await saveInterviewEvaluation(prisma, {
    candidateId: 'candidate-test-observation',
    vacancyId: 'vacancy-test-observation',
    rating: 3.4,
    observationEnabled: true,
    observation: 'Nota temporal.',
    actor
  });
  await saveInterviewEvaluation(prisma, {
    candidateId: 'candidate-test-observation',
    vacancyId: 'vacancy-test-observation',
    rating: 3.4,
    observationEnabled: false,
    observation: 'No debe conservarse',
    actor
  });

  const stored = reviews.get('candidate-test-observation:vacancy-test-observation');
  assert.equal(stored.observationEnabled, false);
  assert.equal(stored.observation, null);
});

test('una etiqueta complementaria se comparte por vacante y cada candidato conserva su valor', async () => {
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
});

test('un campo de otra vacante no puede recibir un valor para este candidato', async () => {
  const { prisma } = createPrismaMock();
  const other = await createInterviewComplementaryField(prisma, {
    vacancyId: 'vacancy-other',
    label: 'Campo de otra vacante',
    actor
  });

  await assert.rejects(
    saveInterviewComplementaryValues(prisma, {
      candidateId: 'candidate-test-scope',
      vacancyId: 'vacancy-current',
      actor,
      values: [{ fieldId: other.field.id, value: 'No permitido' }]
    }),
    /interview_complementary_field_scope_invalid/
  );
});

test('snapshot conserva confirmación, asistencia, clasificación y autoría sin mezclarlos', () => {
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
    values: [{ fieldId: 'field-test', value: 'Valor Prueba', updatedByLabel: 'Usuario Prueba' }]
  });

  assert.equal(snapshot.invitation.status, 'CONFIRMED');
  assert.equal(snapshot.attendance.status, 'ATTENDED');
  assert.equal(snapshot.evaluation.band.key, 'RESERVE');
  assert.equal(snapshot.complementaryFields[0].value, 'Valor Prueba');
});

test('la ruta deriva actor de sesión/AppUser, preserva alcance y activa una única UI por vacante', () => {
  const source = readFileSync(new URL('../src/routes/interviewOutreachManagement.js', import.meta.url), 'utf8');
  assert.match(source, /req\.userId \|\| req\.session\?\.userId/);
  assert.match(source, /displayName:\s*true/);
  assert.match(source, /buildCandidateAccessWhere\(getRequestAccessContext\(req\)\)/);
  assert.match(source, /interviewCandidateReviews:\s*\{\s*some:/);
  assert.doesNotMatch(source, /req\.body\??\.?actor|req\.body\??\.?updatedBy|req\.body\??\.?userId/);
  assert.match(source, /interview-outreach-management\.js/);
  assert.match(source, /data-interview-outreach-management/);
  assert.doesNotMatch(source, /direction:\s*'INBOUND'/);
});

test('las tres entidades nuevas declaran una única autoridad canónica', () => {
  const manifest = JSON.parse(readFileSync(new URL('../docs/architecture/state-authority-manifest.json', import.meta.url), 'utf8'));
  for (const model of ['interviewCandidateReview', 'interviewComplementaryField', 'interviewComplementaryValue']) {
    const contract = manifest.models[model];
    assert.equal(contract.migrationStage, 'canonical');
    assert.equal(contract.targetAuthority, 'InterviewOutreachManagementService');
    assert.deepEqual(contract.writers, [{
      path: 'src/services/interviewOutreachManagement.js',
      role: 'canonical',
      reason: contract.writers[0].reason
    }]);
  }
});

test('server monta la autoridad antes del router administrativo y webhook permanece fuera del cambio', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const managementMount = server.indexOf("app.use('/admin', wrapAsyncRouter(interviewOutreachManagementRouter(prisma)))");
  const adminMount = server.indexOf("app.use('/admin', adminRouter(prisma))");
  assert.ok(managementMount >= 0);
  assert.ok(adminMount > managementMount);

  const webhook = readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  assert.doesNotMatch(webhook, /interviewOutreachManagement/);
});
