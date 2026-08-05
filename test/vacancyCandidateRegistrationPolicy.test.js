import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyVacancyCandidateRegistrationPolicy,
  buildCandidateRegistrationCreatedAtWhere,
  buildVacancyRegistrationCandidateWhere,
  compareCandidatesByRegistrationDesc,
  filterAndSortCandidatesByRegistration,
  normalizeCandidateRegistrationRange,
  normalizeVacancyRegistrationDateFilters
} from '../src/services/vacancyCandidateRegistrationPolicy.js';

function candidate(id, createdAt) {
  return { id, createdAt };
}

test('ordena candidatos desde el registro más reciente al más antiguo', () => {
  const candidates = [
    candidate('old', '2026-07-01T15:00:00.000Z'),
    candidate('new', '2026-07-31T15:00:00.000Z'),
    candidate('middle', '2026-07-15T15:00:00.000Z')
  ];
  assert.deepEqual([...candidates].sort(compareCandidatesByRegistrationDesc).map((item) => item.id), [
    'new', 'middle', 'old'
  ]);
});

test('normaliza rangos invertidos sin perder fechas válidas', () => {
  assert.deepEqual(
    normalizeCandidateRegistrationRange({ dateFrom: '2026-07-31', dateTo: '2026-07-01' }),
    { dateFrom: '2026-07-01', dateTo: '2026-07-31' }
  );
  assert.deepEqual(
    normalizeCandidateRegistrationRange({ dateFrom: '2026-02-31', dateTo: 'texto' }),
    { dateFrom: '', dateTo: '' }
  );
});

test('construye días inclusivos en la zona horaria de Colombia', () => {
  const where = buildCandidateRegistrationCreatedAtWhere({ dateFrom: '2026-07-24', dateTo: '2026-07-24' });
  assert.equal(where.gte.toISOString(), '2026-07-24T05:00:00.000Z');
  assert.equal(where.lte.toISOString(), '2026-07-25T04:59:59.999Z');
});

test('filtra antes de ordenar y conserva los límites completos del día', () => {
  const result = filterAndSortCandidatesByRegistration([
    candidate('before', '2026-07-24T04:59:59.999Z'),
    candidate('first', '2026-07-24T05:00:00.000Z'),
    candidate('last', '2026-07-25T04:59:59.999Z'),
    candidate('after', '2026-07-25T05:00:00.000Z')
  ], { dateFrom: '2026-07-24', dateTo: '2026-07-24' });

  assert.deepEqual(result.map((item) => item.id), ['last', 'first']);
});

test('interpreta rangos independientes por vacante', () => {
  assert.deepEqual(normalizeVacancyRegistrationDateFilters({
    vr_vacancyA_dateFrom: '2026-07-01',
    vr_vacancyA_dateTo: '2026-07-10',
    vr_vacancyB_dateFrom: '2026-08-01',
    unrelated: 'ignore'
  }), {
    vacancyA: { dateFrom: '2026-07-01', dateTo: '2026-07-10' },
    vacancyB: { dateFrom: '2026-08-01', dateTo: '' }
  });
});

test('aplica la misma política a todas las listas de postulados sin tocar entrevistas', () => {
  const vacancy = {
    registeredNoBooking: [candidate('r-old', '2026-07-01T15:00:00Z'), candidate('r-new', '2026-07-10T15:00:00Z')],
    registeredComplete: [candidate('c-new', '2026-07-11T15:00:00Z')],
    completeWithoutCv: [candidate('cv-old', '2026-06-01T15:00:00Z')],
    approvedCandidates: [candidate('a-new', '2026-07-12T15:00:00Z')],
    contractedCandidates: [candidate('h-new', '2026-07-13T15:00:00Z')],
    bookingsToday: [{ id: 'booking-1', scheduledAt: '2026-07-01T12:00:00Z' }]
  };

  applyVacancyCandidateRegistrationPolicy(vacancy, { dateFrom: '2026-07-05', dateTo: '2026-07-31' });
  assert.deepEqual(vacancy.registeredNoBooking.map((item) => item.id), ['r-new']);
  assert.deepEqual(vacancy.registeredComplete.map((item) => item.id), ['c-new']);
  assert.deepEqual(vacancy.completeWithoutCv, []);
  assert.deepEqual(vacancy.approvedCandidates.map((item) => item.id), ['a-new']);
  assert.deepEqual(vacancy.contractedCandidates.map((item) => item.id), ['h-new']);
  assert.deepEqual(vacancy.bookingsToday.map((item) => item.id), ['booking-1']);
});

test('construye condiciones por vacante para búsqueda completa', () => {
  const where = buildVacancyRegistrationCandidateWhere('vacancy-1', {
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31'
  });
  assert.equal(where.vacancyId, 'vacancy-1');
  assert.equal(where.createdAt.gte.toISOString(), '2026-07-01T05:00:00.000Z');
  assert.equal(where.createdAt.lte.toISOString(), '2026-08-01T04:59:59.999Z');
});
