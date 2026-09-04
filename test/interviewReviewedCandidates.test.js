import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_MODULE_PATHS, buildAdminModuleNavbar } from '../src/services/adminNavigation.js';
import {
  deriveInterviewRatingBand,
  isInterviewedCandidateReview,
  normalizeInterviewRating,
  saveInterviewComplementaryValues,
  sortInterviewedCandidateEntries
} from '../src/services/interviewOutreachManagement.js';

const routeSource = readFileSync(new URL('../src/routes/interviewOutreachManagement.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../src/public/interview-outreach-management.js', import.meta.url), 'utf8');

function reviewedEntry(candidateId, rating, updatedAt) {
  return {
    candidateId,
    evaluation: {
      rating,
      updatedAt,
      band: deriveInterviewRatingBand(rating)
    }
  };
}

function complementaryPrisma(fields) {
  const fieldWrites = [];
  const valueWrites = [];
  return {
    fieldWrites,
    valueWrites,
    prisma: {
      interviewComplementaryField: {
        async findMany() {
          return fields.map((field) => ({ ...field }));
        },
        async update(args) {
          fieldWrites.push(args);
          const current = fields.find((field) => field.id === args.where.id);
          return { ...current, ...args.data };
        }
      },
      interviewComplementaryValue: {
        async upsert(args) {
          valueWrites.push(args);
          return {
            candidateId: args.where.candidateId_fieldId.candidateId,
            fieldId: args.where.candidateId_fieldId.fieldId,
            value: args.update.value
          };
        }
      }
    }
  };
}

test('solo asistencia real ATTENDED con calificación persistida entra a Entrevistados', () => {
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: 4.2 }), true);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: '3.00' }), true);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: null }), false);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'NO_SHOW', rating: 4.8 }), false);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'PENDING', rating: 4.8 }), false);
  assert.equal(isInterviewedCandidateReview(null), false);
});

test('la calificación acepta coma o punto y persiste el mismo valor numérico', () => {
  assert.equal(normalizeInterviewRating('3,50'), 3.5);
  assert.equal(normalizeInterviewRating('3.50'), 3.5);
  assert.equal(normalizeInterviewRating('4,25'), 4.25);
  assert.equal(normalizeInterviewRating('4.25'), 4.25);
});

test('los rangos visibles reutilizan exactamente los cortes canónicos', () => {
  assert.deepEqual(deriveInterviewRatingBand(1), { key: 'DISQUALIFIED', label: 'Descalificado' });
  assert.deepEqual(deriveInterviewRatingBand(2.99), { key: 'DISQUALIFIED', label: 'Descalificado' });
  assert.deepEqual(deriveInterviewRatingBand(3), { key: 'RESERVE', label: 'Reserva' });
  assert.deepEqual(deriveInterviewRatingBand(3.59), { key: 'RESERVE', label: 'Reserva' });
  assert.deepEqual(deriveInterviewRatingBand(3.6), { key: 'OPTIONED', label: 'Opcionado a contratar' });
  assert.deepEqual(deriveInterviewRatingBand(5), { key: 'OPTIONED', label: 'Opcionado a contratar' });
});

test('Entrevistados se ordena por calificación descendente respetando los cortes canónicos', () => {
  const entries = [
    reviewedEntry('candidate-test-low', 2.99, '2026-09-01T13:00:00.000Z'),
    reviewedEntry('candidate-test-reserve', 3.59, '2026-09-01T13:00:00.000Z'),
    reviewedEntry('candidate-test-optioned', 3.6, '2026-09-01T13:00:00.000Z'),
    reviewedEntry('candidate-test-top', 5, '2026-09-01T13:00:00.000Z')
  ];

  const sorted = sortInterviewedCandidateEntries(entries);
  assert.deepEqual(sorted.map((entry) => entry.evaluation.rating), [5, 3.6, 3.59, 2.99]);
  assert.deepEqual(sorted.map((entry) => entry.evaluation.band.key), [
    'OPTIONED',
    'OPTIONED',
    'RESERVE',
    'DISQUALIFIED'
  ]);
});

test('el desempate usa actualización de evaluación y luego identificador estable', () => {
  const entries = [
    reviewedEntry('candidate-test-b', 4.5, '2026-09-01T13:00:00.000Z'),
    reviewedEntry('candidate-test-c', 4.5, '2026-09-02T13:00:00.000Z'),
    reviewedEntry('candidate-test-a', 4.5, '2026-09-01T13:00:00.000Z')
  ];

  assert.deepEqual(
    sortInterviewedCandidateEntries(entries).map((entry) => entry.candidateId),
    ['candidate-test-c', 'candidate-test-a', 'candidate-test-b']
  );
});

test('corrige etiqueta global y valor individual conservando el mismo fieldId', async () => {
  const fieldId = 'field-test-travel';
  const { prisma, fieldWrites, valueWrites } = complementaryPrisma([
    { id: fieldId, label: 'Disponiblidad viaje', normalizedLabel: 'disponiblidad viaje' }
  ]);

  const result = await saveInterviewComplementaryValues(prisma, {
    candidateId: 'candidate-test-edit',
    actor: { userId: 'user-test-editor', label: 'Usuario prueba' },
    values: [{
      fieldId,
      label: 'Disponibilidad para viajar',
      value: 'Sí'
    }]
  });

  assert.equal(fieldWrites.length, 1);
  assert.deepEqual(fieldWrites[0], {
    where: { id: fieldId },
    data: {
      label: 'Disponibilidad para viajar',
      normalizedLabel: 'disponibilidad para viajar'
    }
  });
  assert.equal(valueWrites.length, 1);
  assert.deepEqual(valueWrites[0].where, {
    candidateId_fieldId: { candidateId: 'candidate-test-edit', fieldId }
  });
  assert.equal(valueWrites[0].update.value, 'Sí');
  assert.equal(result[0].fieldId, fieldId);
});

test('permite corregir presentación de la etiqueta cuando conserva el mismo normalizedLabel', async () => {
  const fieldId = 'field-test-case';
  const { prisma, fieldWrites } = complementaryPrisma([
    { id: fieldId, label: 'Disponibilidad de viaje', normalizedLabel: 'disponibilidad de viaje' }
  ]);

  await saveInterviewComplementaryValues(prisma, {
    candidateId: 'candidate-test-case',
    actor: { label: 'Usuario prueba' },
    values: [{
      fieldId,
      label: 'DISPONIBILIDAD DE VIAJE',
      value: 'No'
    }]
  });

  assert.equal(fieldWrites.length, 1);
  assert.equal(fieldWrites[0].data.label, 'DISPONIBILIDAD DE VIAJE');
  assert.equal(fieldWrites[0].data.normalizedLabel, 'disponibilidad de viaje');
});

test('rechaza renombrar una etiqueta al nombre normalizado de otro campo y no escribe datos', async () => {
  const { prisma, fieldWrites, valueWrites } = complementaryPrisma([
    { id: 'field-test-origin', label: 'Disponibilidad viaje', normalizedLabel: 'disponibilidad viaje' },
    { id: 'field-test-existing', label: 'Disponibilidad de viaje', normalizedLabel: 'disponibilidad de viaje' }
  ]);

  await assert.rejects(
    saveInterviewComplementaryValues(prisma, {
      candidateId: 'candidate-test-conflict',
      actor: { label: 'Usuario prueba' },
      values: [{
        fieldId: 'field-test-origin',
        label: 'Disponibilidad de viaje',
        value: 'Sí'
      }]
    }),
    /interview_complementary_label_conflict/
  );

  assert.equal(fieldWrites.length, 0);
  assert.equal(valueWrites.length, 0);
});

test('la gestión de entrevistas es una opción libre del módulo Reclutamiento para usuarios ADMIN y DEV', () => {
  assert.equal(ADMIN_MODULE_PATHS.interviewManagement, '/admin?interviewManagement=1');

  const recruiterNav = buildAdminModuleNavbar({
    session: {
      userRole: 'admin',
      userAccessScope: 'VACANCY',
      userAccessVacancyId: 'vacancy-test-scope'
    }
  });
  const devNav = buildAdminModuleNavbar({ session: { userRole: 'dev' } });

  assert.match(recruiterNav, /href="\/admin\?interviewManagement=1">Gestión de entrevistas<\/a>/);
  assert.match(devNav, /href="\/admin\?interviewManagement=1">Gestión de entrevistas<\/a>/);
  assert.match(routeSource, /router\.get\('\/interview-management\/candidates\/:candidateId', apiSessionAuth/);
  assert.match(routeSource, /router\.get\('\/interview-management\/vacancies\/:vacancyId', apiSessionAuth/);
  assert.match(routeSource, /buildVacancyAccessWhere\(getRequestAccessContext\(req\)\)/);
  assert.match(routeSource, /buildCandidateAccessWhere\(getRequestAccessContext\(req\)\)/);
  assert.doesNotMatch(routeSource, /ensureDevRole|canAccessInterviewManagement|canManageInterviewManagement/);
});

test('la ruta deriva el histórico y conserva un único script de gestión de entrevistas', () => {
  assert.match(routeSource, /isInterviewedCandidateReview/);
  assert.match(routeSource, /sortInterviewedCandidateEntries/);
  assert.match(routeSource, /candidateStatus:\s*candidate\.status/);
  assert.match(routeSource, /interviewComplementaryValues:/);
  assert.match(routeSource, /return res\.json\(\{ ok: true, vacancyId, entries, interviewed \}\)/);
  assert.match(routeSource, /data-interview-outreach-management/);
  assert.doesNotMatch(routeSource, /interview-reviewed-candidates/);
  assert.doesNotMatch(routeSource, /prisma\.candidate\.(?:update|updateMany|upsert|create)\s*\(/);
});

test('la UI muestra rangos con coma decimal, distingue bandas y conserva una decisión laboral única', () => {
  assert.match(uiSource, /3,60–5,00 · Opcionado a contratar/);
  assert.match(uiSource, /3,00–3,59 · Reserva/);
  assert.match(uiSource, /1,00–2,99 · Descalificado/);
  assert.match(uiSource, /data-band="OPTIONED"/);
  assert.match(uiSource, /data-band="RESERVE"/);
  assert.match(uiSource, /data-band="DISQUALIFIED"/);
  assert.match(uiSource, /Pendiente de decisión/);
  assert.match(uiSource, /\['CONTRATADO', 'Contratado'\]/);
  assert.match(uiSource, /\['RECHAZADO', 'Rechazado'\]/);
  assert.doesNotMatch(uiSource, /InterviewStatus|decisionStatus|candidateInterviewStatus/);
});

test('el formulario acepta coma o punto y presenta la calificación en formato es-CO', () => {
  assert.match(uiSource, /function formatInterviewRating/);
  assert.match(uiSource, /ratingInput\.type = 'text'/);
  assert.match(uiSource, /ratingInput\.inputMode = 'decimal'/);
  assert.match(uiSource, /ratingInput\.pattern = '\[1-5\]\(\?:\[\.,\]\[0-9\]\{1,2\}\)\?'/);
  assert.match(uiSource, /ratingInput\.placeholder = '1,00 a 5,00'/);
  assert.match(uiSource, /formatInterviewRating\(management\.evaluation\?\.rating\)/);
  assert.match(uiSource, /formatInterviewRating\(entry\.evaluation\?\.rating\)/);
});

test('la UI evita textos explicativos redundantes y conserva ayudas con reglas reales', () => {
  assert.doesNotMatch(uiSource, /Coordina entrevistas y consulta el histórico evaluado/);
  assert.doesNotMatch(uiSource, /Asistencia real, evaluación e información complementaria/);
  assert.doesNotMatch(uiSource, /Registra aquí si asistió o no asistió/);
  assert.doesNotMatch(uiSource, /La etiqueta es global para Reclutamiento/);
  assert.doesNotMatch(uiSource, /Al crearlo quedará disponible para todas las vacantes/);
  assert.doesNotMatch(uiSource, /Campo agregado para todas las vacantes/);
  assert.doesNotMatch(uiSource, /ic-subtitle/);
  assert.match(uiSource, /Escala de 1 a 5\. Usa coma o punto decimal\./);
});

test('información complementaria permite editar etiqueta global y valor individual en el mismo formulario', () => {
  assert.match(uiSource, /managementField\('Etiqueta', labelInput\)/);
  assert.match(uiSource, /managementField\('Valor', input\)/);
  assert.match(uiSource, /labelInput\.value = item\.label \|\| ''/);
  assert.match(uiSource, /input\.value = item\.value \|\| ''/);
  assert.match(uiSource, /label: labelInput\.value/);
  assert.match(uiSource, /value: input\.value/);
  assert.match(uiSource, /Guardar evaluación e información/);
  assert.match(uiSource, /interview_complementary_label_conflict/);
});

test('edición reutiliza endpoints canónicos y la decisión reutiliza el cambio de estado administrativo', () => {
  assert.match(uiSource, /\/attendance/);
  assert.match(uiSource, /\/evaluation/);
  assert.match(uiSource, /editor\.appendChild\(buildDayManagementPanel\(entry\.candidateId, response, refresh\)\)/);
  assert.match(uiSource, /\/admin\/candidates\/\$\{encodeURIComponent\(entry\.candidateId\)\}\/status/);
  assert.match(uiSource, /application\/x-www-form-urlencoded/);
  assert.match(uiSource, /new URLSearchParams\(\{ status: nextStatus, returnTo \}\)/);
  assert.doesNotMatch(uiSource, /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
});
