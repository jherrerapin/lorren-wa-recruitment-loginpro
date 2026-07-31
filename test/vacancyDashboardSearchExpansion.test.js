import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateMatchesVacancyDashboardSearch,
  isCandidateVisibleForVacancySearch,
  mergeVacancySearchResults,
  normalizeVacancyDashboardSearches
} from '../src/services/vacancyDashboardSearchExpansion.js';

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
    ['candidate-other-date', 'candidate-unrelated']
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
