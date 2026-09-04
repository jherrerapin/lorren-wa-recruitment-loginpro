import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deriveInterviewRatingBand,
  isInterviewedCandidateReview,
  sortInterviewedCandidateEntries
} from '../src/services/interviewOutreachManagement.js';

const routeSource = readFileSync(new URL('../src/routes/interviewOutreachManagement.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../src/public/interview-reviewed-candidates.js', import.meta.url), 'utf8');

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

test('solo asistencia real ATTENDED con calificación persistida entra a Entrevistados', () => {
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: 4.2 }), true);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: '3.00' }), true);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'ATTENDED', rating: null }), false);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'NO_SHOW', rating: 4.8 }), false);
  assert.equal(isInterviewedCandidateReview({ attendanceStatus: 'PENDING', rating: 4.8 }), false);
  assert.equal(isInterviewedCandidateReview(null), false);
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

test('la ruta deriva el histórico y no se convierte en writer de Candidate.status', () => {
  assert.match(routeSource, /isInterviewedCandidateReview/);
  assert.match(routeSource, /sortInterviewedCandidateEntries/);
  assert.match(routeSource, /candidateStatus:\s*candidate\.status/);
  assert.match(routeSource, /interviewComplementaryValues:/);
  assert.match(routeSource, /return res\.json\(\{ ok: true, vacancyId, entries, interviewed \}\)/);
  assert.match(routeSource, /data-interview-reviewed-candidates/);
  assert.doesNotMatch(routeSource, /prisma\.candidate\.(?:update|updateMany|upsert|create)\s*\(/);
});

test('la UI muestra los rangos, distingue bandas y conserva una decisión laboral única', () => {
  assert.match(uiSource, /3\.60–5\.00 · Opcionado a contratar/);
  assert.match(uiSource, /3\.00–3\.59 · Reserva/);
  assert.match(uiSource, /1\.00–2\.99 · Descalificado/);
  assert.match(uiSource, /data-band="OPTIONED"/);
  assert.match(uiSource, /data-band="RESERVE"/);
  assert.match(uiSource, /data-band="DISQUALIFIED"/);
  assert.match(uiSource, /Pendiente de decisión/);
  assert.match(uiSource, /\['CONTRATADO', 'Contratado'\]/);
  assert.match(uiSource, /\['RECHAZADO', 'Rechazado'\]/);
  assert.doesNotMatch(uiSource, /InterviewStatus|decisionStatus|candidateInterviewStatus/);
});

test('edición reutiliza endpoints canónicos y la decisión reutiliza el cambio de estado administrativo', () => {
  assert.match(uiSource, /\/attendance/);
  assert.match(uiSource, /\/evaluation/);
  assert.match(uiSource, /\/admin\/candidates\/\$\{encodeURIComponent\(entry\.candidateId\)\}\/status/);
  assert.match(uiSource, /application\/x-www-form-urlencoded/);
  assert.match(uiSource, /new URLSearchParams\(\{ status: nextStatus, returnTo \}\)/);
  assert.doesNotMatch(uiSource, /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
});
