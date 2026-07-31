import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateMatchesVacancyDashboardSearch,
  expandVacancySearchCandidates,
  normalizeVacancyDashboardSearches
} from '../src/services/vacancyDashboardSearchExpansion.js';

function createVacancy(overrides = {}) {
  return {
    id: 'vacancy-1',
    schedulingEnabled: true,
    acceptingApplications: true,
    dashboardReviewEnabled: false,
    candidates: [],
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
  assert.deepEqual(normalizeVacancyDashboardSearches({
    'vs_vacancy-1_field': 'phone',
    'vs_vacancy-1_text': '300 123 4567',
    'vs_vacancy-2_field': 'document',
    'vs_vacancy-2_text': '1.111.222.333'
  }), {
    'vacancy-1': { field: 'phone', text: '300 123 4567' },
    'vacancy-2': { field: 'document', text: '1.111.222.333' }
  });
});

test('compara celulares con o sin prefijo 57', () => {
  assert.equal(candidateMatchesVacancyDashboardSearch(
    { phone: '573001234567' },
    { field: 'phone', text: '3001234567' }
  ), true);

  assert.equal(candidateMatchesVacancyDashboardSearch(
    { phone: '3001234567' },
    { field: 'phone', text: '+57 300 123 4567' }
  ), true);
});

test('incorpora un candidato que estaba fuera de los bloques comprimidos', () => {
  const hiddenCandidate = {
    id: 'candidate-hidden',
    fullName: 'Candidato fuera del resumen',
    phone: '573001234567',
    documentType: 'CC',
    documentNumber: '1111222333',
    status: 'NUEVO',
    gender: 'UNKNOWN',
    createdAt: new Date('2026-07-31T15:00:00.000Z')
  };
  const vacancy = createVacancy({ candidates: [hiddenCandidate] });
  const model = { cities: [{ name: 'Ibagué', vacancies: [vacancy] }] };

  expandVacancySearchCandidates(model, {
    'vs_vacancy-1_field': 'document',
    'vs_vacancy-1_text': '1111222333'
  });

  assert.equal(vacancy.registeredNoBooking.length, 1);
  assert.equal(vacancy.registeredNoBooking[0].id, hiddenCandidate.id);
});

test('no duplica candidatos que ya estaban visibles', () => {
  const visibleCandidate = {
    id: 'candidate-visible',
    phone: '3009998877',
    documentNumber: '999887766'
  };
  const vacancy = createVacancy({
    candidates: [visibleCandidate],
    registeredNoBooking: [visibleCandidate]
  });
  const model = { cities: [{ name: 'Neiva', vacancies: [vacancy] }] };

  expandVacancySearchCandidates(model, {
    'vs_vacancy-1_field': 'phone',
    'vs_vacancy-1_text': '3009998877'
  });

  assert.equal(vacancy.registeredNoBooking.length, 1);
});

test('mantiene la búsqueda dentro de la vacante seleccionada', () => {
  const firstVacancy = createVacancy({
    id: 'vacancy-1',
    candidates: [{ id: 'candidate-1', documentNumber: '123456789' }]
  });
  const secondVacancy = createVacancy({
    id: 'vacancy-2',
    candidates: [{ id: 'candidate-2', documentNumber: '123456789' }]
  });
  const model = { cities: [{ name: 'Bogotá', vacancies: [firstVacancy, secondVacancy] }] };

  expandVacancySearchCandidates(model, {
    'vs_vacancy-2_field': 'document',
    'vs_vacancy-2_text': '123456789'
  });

  assert.equal(firstVacancy.registeredNoBooking.length, 0);
  assert.equal(secondVacancy.registeredNoBooking.length, 1);
  assert.equal(secondVacancy.registeredNoBooking[0].id, 'candidate-2');
});
