import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateMatchesVacancyDashboardSearch,
  isCandidateVisibleForVacancySearch,
  mergeVacancySearchResults,
  normalizeVacancyDashboardSearches
} from '../src/services/vacancyDashboardSearchExpansion.js';
import {
  applyVacancyCandidateRegistrationPolicy,
  buildCandidateRegistrationCreatedAtWhere,
  buildVacancyRegistrationCandidateWhere,
  compareCandidatesByRegistrationDesc,
  filterAndSortCandidatesByRegistration,
  normalizeCandidateRegistrationRange,
  normalizeVacancyRegistrationDateFilters
} from '../src/services/vacancyCandidateRegistrationPolicy.js';

function completeCandidate(overrides = {}) {
  return {
    id: 'candidate-complete',
    vacancyId: 'vacancy-1',
    fullName: 'María Prueba',
    phone: '573201234567',
    documentType: 'CC',
    documentNumber: '1.023.456.789',
    age: 28,
    neighborhood: 'Centro',
    locality: 'Sur',
    medicalRestrictions: 'Ninguna',
    transportMode: 'Moto',
    cvStorageKey: 'cv/candidate-complete.pdf',
    status: 'REGISTRADO',
    createdAt: new Date('2026-07-01T12:00:00.000Z'),
    vacancy: {
      id: 'vacancy-1',
      title: 'Auxiliar de operación',
      role: 'Auxiliar',
      city: 'Ibagué'
    },
    ...overrides
  };
}

test('normaliza búsquedas independientes por vacante', () => {
  const result = normalizeVacancyDashboardSearches({
    'vs_vacancy-1_field': 'phone',
    'vs_vacancy-1_text': '320 123 4567',
    'vs_vacancy-2_field': 'invalid',
    'vs_vacancy-2_text': '1.023.456.789'
  });

  assert.deepEqual(result, {
    'vacancy-1': { field: 'phone', text: '320 123 4567' },
    'vacancy-2': { field: 'document', text: '1.023.456.789' }
  });
});

test('busca por documento y celular normalizando formatos y prefijo 57', () => {
  const candidate = completeCandidate();

  assert.equal(candidateMatchesVacancyDashboardSearch(candidate, {
    field: 'document',
    text: '1023456'
  }), true);
  assert.equal(candidateMatchesVacancyDashboardSearch(candidate, {
    field: 'phone',
    text: '320-123-4567'
  }), true);
  assert.equal(candidateMatchesVacancyDashboardSearch(candidate, {
    field: 'phone',
    text: '3100000000'
  }), false);
});

test('un reclutador solo puede obtener registros completos con hoja de vida', () => {
  const complete = completeCandidate();
  const withoutCv = completeCandidate({ cvStorageKey: null, cvOriginalName: null, cvMimeType: null });
  const withoutResidence = completeCandidate({ neighborhood: null, locality: null, zone: null });

  assert.equal(isCandidateVisibleForVacancySearch(complete, { isDev: false }), true);
  assert.equal(isCandidateVisibleForVacancySearch(withoutCv, { isDev: false }), false);
  assert.equal(isCandidateVisibleForVacancySearch(withoutResidence, { isDev: false }), false);
  assert.equal(isCandidateVisibleForVacancySearch(withoutCv, { isDev: true }), true);
});

test('agrega una coincidencia omitida del resumen y conserva candidatos no relacionados', () => {
  const unrelated = completeCandidate({
    id: 'candidate-unrelated',
    documentNumber: '999999999'
  });
  const hiddenBySummary = completeCandidate({
    id: 'candidate-other-date',
    documentNumber: '1023456789'
  });
  const unauthorizedMatch = completeCandidate({
    id: 'candidate-without-cv',
    documentNumber: '1023456000',
    cvStorageKey: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const viewModel = {
    cities: [{
      name: 'Ibagué',
      vacancies: [{
        id: 'vacancy-1',
        schedulingEnabled: true,
        acceptingApplications: true,
        dashboardReviewEnabled: false,
        bookingsToday: [],
        registeredNoBooking: [unrelated],
        registeredComplete: [],
        completeWithoutCv: [unauthorizedMatch],
        approvedCandidates: [],
        contractedCandidates: []
      }]
    }]
  };
  const searches = {
    'vacancy-1': { field: 'document', text: '1023456' }
  };

  mergeVacancySearchResults(viewModel, searches, [hiddenBySummary, unauthorizedMatch], { isDev: false });

  const vacancy = viewModel.cities[0].vacancies[0];
  assert.deepEqual(
    vacancy.registeredNoBooking.map((candidate) => candidate.id),
    ['candidate-unrelated', 'candidate-other-date']
  );
  assert.equal(vacancy.completeWithoutCv.some((candidate) => candidate.id === 'candidate-without-cv'), false);
});

test('DEV puede recuperar un registro incompleto omitido del resumen', () => {
  const incomplete = completeCandidate({
    id: 'candidate-incomplete',
    fullName: null,
    cvStorageKey: null,
    documentNumber: '777123456'
  });
  const viewModel = {
    cities: [{
      name: 'Ibagué',
      vacancies: [{
        id: 'vacancy-1',
        schedulingEnabled: true,
        acceptingApplications: true,
        dashboardReviewEnabled: false,
        bookingsToday: [],
        registeredNoBooking: [],
        registeredComplete: [],
        completeWithoutCv: [],
        approvedCandidates: [],
        contractedCandidates: []
      }]
    }]
  };

  mergeVacancySearchResults(
    viewModel,
    { 'vacancy-1': { field: 'document', text: '777123456' } },
    [incomplete],
    { isDev: true }
  );

  assert.equal(viewModel.cities[0].vacancies[0].registeredNoBooking[0].id, 'candidate-incomplete');
});

function registrationCandidate(id, createdAt) {
  return { id, createdAt };
}

test('ordena postulados desde el registro más reciente al más antiguo', () => {
  const candidates = [
    registrationCandidate('old', '2026-07-01T15:00:00.000Z'),
    registrationCandidate('new', '2026-07-31T15:00:00.000Z'),
    registrationCandidate('middle', '2026-07-15T15:00:00.000Z')
  ];
  assert.deepEqual([...candidates].sort(compareCandidatesByRegistrationDesc).map((item) => item.id), [
    'new', 'middle', 'old'
  ]);
});

test('normaliza rangos invertidos y descarta fechas inexistentes', () => {
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

test('filtra el rango antes de ordenar y antes del límite visual', () => {
  const result = filterAndSortCandidatesByRegistration([
    registrationCandidate('before', '2026-07-24T04:59:59.999Z'),
    registrationCandidate('first', '2026-07-24T05:00:00.000Z'),
    registrationCandidate('last', '2026-07-25T04:59:59.999Z'),
    registrationCandidate('after', '2026-07-25T05:00:00.000Z')
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

test('aplica la política a postulados sin cambiar el orden de entrevistas', () => {
  const vacancy = {
    registeredNoBooking: [registrationCandidate('r-old', '2026-07-01T15:00:00Z'), registrationCandidate('r-new', '2026-07-10T15:00:00Z')],
    registeredComplete: [registrationCandidate('c-new', '2026-07-11T15:00:00Z')],
    completeWithoutCv: [registrationCandidate('cv-old', '2026-06-01T15:00:00Z')],
    approvedCandidates: [registrationCandidate('a-new', '2026-07-12T15:00:00Z')],
    contractedCandidates: [registrationCandidate('h-new', '2026-07-13T15:00:00Z')],
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

test('construye condiciones de búsqueda por vacante y rango de registro', () => {
  const where = buildVacancyRegistrationCandidateWhere('vacancy-1', {
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31'
  });
  assert.equal(where.vacancyId, 'vacancy-1');
  assert.equal(where.createdAt.gte.toISOString(), '2026-07-01T05:00:00.000Z');
  assert.equal(where.createdAt.lte.toISOString(), '2026-08-01T04:59:59.999Z');
});
