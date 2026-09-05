import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildInterviewManagementSnapshot,
  isInterviewedCandidateReview,
  normalizeInterviewContinuationStatus,
  setInterviewAttendanceStatus,
  setInterviewContinuationStatus
} from '../src/services/interviewOutreachManagement.js';

const routeSource = readFileSync(new URL('../src/routes/interviewOutreachManagement.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../src/public/interview-outreach-management.js', import.meta.url), 'utf8');

function createReviewPrismaMock() {
  const reviews = new Map();
  const keyFor = (candidateId, vacancyId) => `${candidateId}:${vacancyId}`;

  const prisma = {
    interviewCandidateReview: {
      async upsert({ where, update, create }) {
        const { candidateId, vacancyId } = where.candidateId_vacancyId;
        const key = keyFor(candidateId, vacancyId);
        const current = reviews.get(key);
        const next = current
          ? { ...current, ...update }
          : {
              id: `review-test-${reviews.size + 1}`,
              attendanceStatus: 'PENDING',
              continuationStatus: 'CONTINUES',
              observationEnabled: false,
              ...create
            };
        reviews.set(key, next);
        return structuredClone(next);
      },
      async findUnique({ where }) {
        const { candidateId, vacancyId } = where.candidateId_vacancyId;
        const current = reviews.get(keyFor(candidateId, vacancyId));
        return current ? structuredClone(current) : null;
      },
      async update({ where, data }) {
        const { candidateId, vacancyId } = where.candidateId_vacancyId;
        const key = keyFor(candidateId, vacancyId);
        const current = reviews.get(key);
        if (!current) throw new Error('review_test_not_found');
        const next = { ...current, ...data };
        reviews.set(key, next);
        return structuredClone(next);
      }
    }
  };

  return { prisma, reviews };
}

const actor = { userId: 'user-test-continuation', label: 'Usuario Prueba Continuidad' };

test('normaliza únicamente los dos estados de continuidad posterior acordados', () => {
  assert.equal(normalizeInterviewContinuationStatus('continues'), 'CONTINUES');
  assert.equal(normalizeInterviewContinuationStatus('withdrew'), 'WITHDREW');
  assert.throws(
    () => normalizeInterviewContinuationStatus('DECLINED'),
    /interview_continuation_status_invalid/
  );
});

test('solo una asistencia ATTENDED puede pasar de Continúa a Desistió', async () => {
  const { prisma, reviews } = createReviewPrismaMock();
  const candidateId = 'candidate-test-withdrawal-a';
  const vacancyId = 'vacancy-test-withdrawal-a';

  await setInterviewAttendanceStatus(prisma, {
    candidateId,
    vacancyId,
    status: 'NO_SHOW',
    actor
  });
  await assert.rejects(
    setInterviewContinuationStatus(prisma, {
      candidateId,
      vacancyId,
      candidateStatus: 'APROBADO',
      status: 'WITHDREW',
      actor
    }),
    /interview_continuation_requires_attendance/
  );

  await setInterviewAttendanceStatus(prisma, {
    candidateId,
    vacancyId,
    status: 'ATTENDED',
    actor,
    now: '2026-09-05T00:10:00.000Z'
  });
  await setInterviewContinuationStatus(prisma, {
    candidateId,
    vacancyId,
    candidateStatus: 'APROBADO',
    status: 'WITHDREW',
    actor,
    now: '2026-09-05T00:20:00.000Z'
  });

  const stored = reviews.get(`${candidateId}:${vacancyId}`);
  assert.equal(stored.attendanceStatus, 'ATTENDED');
  assert.equal(stored.continuationStatus, 'WITHDREW');
  assert.equal(stored.continuationUpdatedByUserId, actor.userId);
  assert.equal(stored.continuationUpdatedByLabel, actor.label);
});

test('corregir asistencia limpia un desistimiento previo para no dejar estados incompatibles', async () => {
  const { prisma, reviews } = createReviewPrismaMock();
  const candidateId = 'candidate-test-withdrawal-reset';
  const vacancyId = 'vacancy-test-withdrawal-reset';

  await setInterviewAttendanceStatus(prisma, { candidateId, vacancyId, status: 'ATTENDED', actor });
  await setInterviewContinuationStatus(prisma, {
    candidateId,
    vacancyId,
    candidateStatus: 'APROBADO',
    status: 'WITHDREW',
    actor
  });
  await setInterviewAttendanceStatus(prisma, {
    candidateId,
    vacancyId,
    status: 'NO_SHOW',
    actor
  });

  const stored = reviews.get(`${candidateId}:${vacancyId}`);
  assert.equal(stored.attendanceStatus, 'NO_SHOW');
  assert.equal(stored.continuationStatus, 'CONTINUES');
  assert.equal(stored.continuationUpdatedByUserId, null);
  assert.equal(stored.continuationUpdatedByLabel, null);
  assert.equal(stored.continuationUpdatedAt, null);
});

test('reactivar el proceso devuelve el estado a CONTINUES sin borrar asistencia ni calificación', async () => {
  const { prisma, reviews } = createReviewPrismaMock();
  const candidateId = 'candidate-test-withdrawal-reactivate';
  const vacancyId = 'vacancy-test-withdrawal-reactivate';

  await setInterviewAttendanceStatus(prisma, { candidateId, vacancyId, status: 'ATTENDED', actor });
  reviews.set(`${candidateId}:${vacancyId}`, {
    ...reviews.get(`${candidateId}:${vacancyId}`),
    rating: 4.1
  });
  await setInterviewContinuationStatus(prisma, {
    candidateId,
    vacancyId,
    candidateStatus: 'APROBADO',
    status: 'WITHDREW',
    actor
  });
  await setInterviewContinuationStatus(prisma, {
    candidateId,
    vacancyId,
    candidateStatus: 'APROBADO',
    status: 'CONTINUES',
    actor
  });

  const stored = reviews.get(`${candidateId}:${vacancyId}`);
  assert.equal(stored.attendanceStatus, 'ATTENDED');
  assert.equal(stored.rating, 4.1);
  assert.equal(stored.continuationStatus, 'CONTINUES');
});

test('una decisión laboral final bloquea cambios posteriores de continuidad', async () => {
  const { prisma } = createReviewPrismaMock();
  const candidateId = 'candidate-test-final-decision';
  const vacancyId = 'vacancy-test-final-decision';
  await setInterviewAttendanceStatus(prisma, { candidateId, vacancyId, status: 'ATTENDED', actor });

  for (const candidateStatus of ['CONTRATADO', 'RECHAZADO']) {
    await assert.rejects(
      setInterviewContinuationStatus(prisma, {
        candidateId,
        vacancyId,
        candidateStatus,
        status: 'WITHDREW',
        actor
      }),
      /interview_continuation_final_decision_exists/
    );
  }
});

test('Desistió sigue siendo entrevistado aunque falte nota, pero Continúa sin nota queda pendiente de calificación', () => {
  assert.equal(isInterviewedCandidateReview({
    attendanceStatus: 'ATTENDED',
    continuationStatus: 'WITHDREW',
    rating: null
  }), true);
  assert.equal(isInterviewedCandidateReview({
    attendanceStatus: 'ATTENDED',
    continuationStatus: 'CONTINUES',
    rating: null
  }), false);
  assert.equal(isInterviewedCandidateReview({
    attendanceStatus: 'ATTENDED',
    continuationStatus: 'CONTINUES',
    rating: 4.25
  }), true);
  assert.equal(isInterviewedCandidateReview({
    attendanceStatus: 'NO_SHOW',
    continuationStatus: 'WITHDREW',
    rating: 4.25
  }), false);
});

test('snapshot conserva continuidad como dimensión separada de invitación, asistencia y evaluación', () => {
  const snapshot = buildInterviewManagementSnapshot({
    review: {
      invitationStatusOverride: 'CONFIRMED',
      attendanceStatus: 'ATTENDED',
      continuationStatus: 'WITHDREW',
      continuationUpdatedByLabel: 'Usuario Prueba Continuidad',
      continuationUpdatedAt: new Date('2026-09-05T00:20:00.000Z'),
      rating: null
    }
  });

  assert.equal(snapshot.invitation.status, 'CONFIRMED');
  assert.equal(snapshot.attendance.status, 'ATTENDED');
  assert.equal(snapshot.continuation.status, 'WITHDREW');
  assert.equal(snapshot.continuation.updatedByLabel, 'Usuario Prueba Continuidad');
  assert.equal(snapshot.evaluation.rating, null);
});

test('ruta delega continuidad al servicio canónico y DEV recibe la transición, incluida limpieza por asistencia', () => {
  assert.match(
    routeSource,
    /router\.post\('\/interview-management\/candidates\/:candidateId\/continuation', apiSessionAuth/
  );
  assert.match(routeSource, /setInterviewContinuationStatus\(prisma,/);
  assert.match(routeSource, /candidateStatus:\s*data\.candidate\.status/);
  assert.match(routeSource, /continuation:\s*snapshot\.continuation/);
  assert.match(routeSource, /INTERVIEW_CONTINUATION_STATUS_CHANGED/);
  assert.match(routeSource, /Actualizó continuidad después de entrevista/);
  assert.match(routeSource, /action === 'continuation' \|\| action === 'attendance'/);
  assert.match(routeSource, /Ajuste automático por corrección de asistencia/);
});

test('UI separa No interesado previo de Desistió posterior y no deja decisión laboral activa al desistir', () => {
  assert.match(uiSource, /\['DECLINED', 'No interesado'\]/);
  assert.match(uiSource, /\['WITHDREW', 'Desistió del proceso'\]/);
  assert.match(uiSource, /\['CONTINUES', 'Continúa en proceso'\]/);
  assert.match(uiSource, /\/continuation/);
  assert.match(uiSource, /Guardar continuidad/);
  assert.match(uiSource, /card\.dataset\.continuation = withdrew \? 'WITHDREW' : 'CONTINUES'/);
  assert.match(uiSource, /if \(!withdrew\) \{[\s\S]*managementField\('Decisión final'/);
  assert.match(uiSource, /Editar \/ reactivar/);
  assert.doesNotMatch(uiSource, /Por evaluar/);
});
