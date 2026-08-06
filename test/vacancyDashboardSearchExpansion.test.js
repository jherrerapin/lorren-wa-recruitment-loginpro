import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateMatchesVacancyDashboardSearch,
  mergeVacancySearchResults,
  normalizeVacancyDashboardSearches
} from '../src/services/vacancyDashboardSearchExpansion.js';

function candidate(overrides = {}) {
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

function dashboardVacancy(overrides = {}) {
  return {
    id: 'vacancy-1',
    schedulingEnabled: true,
    acceptingApplications: true,
    dashboardReviewEnabled: false,
    bookingsToday: [],
    registeredNoBooking: [],
    registeredComplete: [],
    completeWithoutCv: [],
    approvedCandidates: [],
    contractedCandidates: [],
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
  const record = candidate();

  assert.equal(candidateMatchesVacancyDashboardSearch(record, {
    field: 'document',
    text: '1023456'
  }), true);
  assert.equal(candidateMatchesVacancyDashboardSearch(record, {
    field: 'phone',
    text: '320-123-4567'
  }), true);
  assert.equal(candidateMatchesVacancyDashboardSearch(record, {
    field: 'phone',
    text: '3100000000'
  }), false);
});

test('incluye candidatos de toda la vacante aunque no tengan hoja de vida o datos completos', () => {
  const withoutCv = candidate({
    id: 'candidate-without-cv',
    fullName: null,
    documentNumber: '777123456',
    age: null,
    neighborhood: null,
    locality: null,
    medicalRestrictions: null,
    transportMode: null,
    cvStorageKey: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const viewModel = {
    cities: [{ name: 'Ibagué', vacancies: [dashboardVacancy()] }]
  };

  mergeVacancySearchResults(
    viewModel,
    { 'vacancy-1': { field: 'document', text: '777123456' } },
    [withoutCv]
  );

  assert.equal(viewModel.cities[0].vacancies[0].registeredNoBooking[0].id, 'candidate-without-cv');
});

test('agrega una coincidencia omitida del resumen y conserva los registros existentes', () => {
  const unrelated = candidate({
    id: 'candidate-unrelated',
    documentNumber: '999999999'
  });
  const hiddenBySummary = candidate({
    id: 'candidate-other-date',
    documentNumber: '1023456789'
  });
  const existingWithoutCv = candidate({
    id: 'candidate-without-cv',
    documentNumber: '1023456000',
    cvStorageKey: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const viewModel = {
    cities: [{
      name: 'Ibagué',
      vacancies: [dashboardVacancy({
        registeredNoBooking: [unrelated],
        completeWithoutCv: [existingWithoutCv]
      })]
    }]
  };

  mergeVacancySearchResults(
    viewModel,
    { 'vacancy-1': { field: 'document', text: '1023456' } },
    [hiddenBySummary, existingWithoutCv]
  );

  const vacancy = viewModel.cities[0].vacancies[0];
  assert.deepEqual(
    vacancy.registeredNoBooking.map((entry) => entry.id),
    ['candidate-other-date', 'candidate-unrelated']
  );
  assert.equal(vacancy.completeWithoutCv.some((entry) => entry.id === 'candidate-without-cv'), true);
});

test('mantiene aprobados y contratados en su sección real al recuperarlos', () => {
  const approved = candidate({
    id: 'candidate-approved',
    documentNumber: '555000111',
    status: 'APROBADO'
  });
  const contracted = candidate({
    id: 'candidate-contracted',
    documentNumber: '555000222',
    status: 'CONTRATADO'
  });
  const viewModel = {
    cities: [{ name: 'Ibagué', vacancies: [dashboardVacancy()] }]
  };

  mergeVacancySearchResults(
    viewModel,
    { 'vacancy-1': { field: 'document', text: '555000' } },
    [approved, contracted]
  );

  const vacancy = viewModel.cities[0].vacancies[0];
  assert.equal(vacancy.approvedCandidates[0].id, 'candidate-approved');
  assert.equal(vacancy.contractedCandidates[0].id, 'candidate-contracted');
});
