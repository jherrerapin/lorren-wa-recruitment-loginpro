import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateMatchesApplicantDateRange,
  candidateMatchesVacancyDashboardSearch,
  compareCandidatesByRegisteredAtDesc,
  enhanceLegacyApplicantList,
  injectAdminApplicantControls,
  isCandidateVisibleForVacancySearch,
  mergeVacancySearchResults,
  normalizeApplicantDateRange,
  normalizeVacancyDashboardSearches,
  sanitizeVacancyDashboardVisibility
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

function vacancyModel(overrides = {}) {
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

function vacancyCandidateIds(vacancy) {
  return [
    ...vacancy.registeredNoBooking,
    ...vacancy.registeredComplete,
    ...vacancy.completeWithoutCv,
    ...vacancy.approvedCandidates,
    ...vacancy.contractedCandidates
  ].map((candidate) => candidate.id);
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

test('reclutadores solo ven datos operativos completos, con o sin HV', () => {
  const completeWithCv = completeCandidate();
  const completeWithoutCv = completeCandidate({
    cvStorageKey: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const incomplete = completeCandidate({ transportMode: null });

  assert.equal(isCandidateVisibleForVacancySearch(completeWithCv, { isDev: false }), true);
  assert.equal(isCandidateVisibleForVacancySearch(completeWithoutCv, { isDev: false }), true);
  assert.equal(isCandidateVisibleForVacancySearch(incomplete, { isDev: false }), false);
  assert.equal(isCandidateVisibleForVacancySearch(incomplete, { isDev: true }), true);
});

test('separa completos con HV y completos pendientes de HV, y elimina incompletos', () => {
  const recentWithCv = completeCandidate({
    id: 'recent-with-cv',
    createdAt: new Date('2026-07-05T12:00:00.000Z')
  });
  const oldWithCv = completeCandidate({
    id: 'old-with-cv',
    createdAt: new Date('2026-07-01T12:00:00.000Z')
  });
  const withoutCv = completeCandidate({
    id: 'without-cv',
    cvStorageKey: null,
    cvOriginalName: null,
    cvMimeType: null,
    createdAt: new Date('2026-07-04T12:00:00.000Z')
  });
  const incomplete = completeCandidate({
    id: 'incomplete',
    medicalRestrictions: null
  });
  const approved = completeCandidate({
    id: 'approved',
    status: 'APROBADO',
    createdAt: new Date('2026-07-03T12:00:00.000Z')
  });

  const model = {
    cities: [{
      name: 'Ibagué',
      vacancies: [vacancyModel({
        registeredNoBooking: [oldWithCv, withoutCv, recentWithCv],
        approvedCandidates: [incomplete, approved]
      })]
    }]
  };

  sanitizeVacancyDashboardVisibility(model, { isDev: false });
  const vacancy = model.cities[0].vacancies[0];

  assert.deepEqual(
    vacancy.registeredNoBooking.map((candidate) => candidate.id),
    ['recent-with-cv', 'old-with-cv']
  );
  assert.deepEqual(
    vacancy.completeWithoutCv.map((candidate) => candidate.id),
    ['without-cv']
  );
  assert.deepEqual(
    vacancy.approvedCandidates.map((candidate) => candidate.id),
    ['approved']
  );
});

test('la búsqueda recupera toda la vacante sin mostrar incompletos y conserva cada sección', () => {
  const completeHidden = completeCandidate({
    id: 'complete-hidden',
    documentNumber: '1023456789',
    createdAt: new Date('2026-07-06T12:00:00.000Z')
  });
  const pendingHvHidden = completeCandidate({
    id: 'pending-hv-hidden',
    documentNumber: '1023456000',
    cvStorageKey: null,
    cvOriginalName: null,
    cvMimeType: null,
    createdAt: new Date('2026-07-05T12:00:00.000Z')
  });
  const incompleteHidden = completeCandidate({
    id: 'incomplete-hidden',
    documentNumber: '1023456111',
    fullName: null
  });
  const existing = completeCandidate({
    id: 'existing',
    documentNumber: '999999999',
    createdAt: new Date('2026-07-01T12:00:00.000Z')
  });
  const model = {
    cities: [{
      name: 'Ibagué',
      vacancies: [vacancyModel({ registeredNoBooking: [existing] })]
    }]
  };

  mergeVacancySearchResults(
    model,
    { 'vacancy-1': { field: 'document', text: '1023456' } },
    [completeHidden, pendingHvHidden, incompleteHidden],
    { isDev: false }
  );

  const vacancy = model.cities[0].vacancies[0];
  assert.deepEqual(
    vacancy.registeredNoBooking.map((candidate) => candidate.id),
    ['complete-hidden', 'existing']
  );
  assert.deepEqual(
    vacancy.completeWithoutCv.map((candidate) => candidate.id),
    ['pending-hv-hidden']
  );
  assert.equal(vacancyCandidateIds(vacancy).includes('incomplete-hidden'), false);
});

test('el rango de fechas usa días de Colombia y valida rangos invertidos', () => {
  const range = normalizeApplicantDateRange({
    dateFrom: '2026-07-10',
    dateTo: '2026-07-10'
  });
  assert.equal(range.isActive, true);
  assert.equal(candidateMatchesApplicantDateRange(
    completeCandidate({ createdAt: new Date('2026-07-10T05:00:00.000Z') }),
    range
  ), true);
  assert.equal(candidateMatchesApplicantDateRange(
    completeCandidate({ createdAt: new Date('2026-07-11T04:59:59.999Z') }),
    range
  ), true);
  assert.equal(candidateMatchesApplicantDateRange(
    completeCandidate({ createdAt: new Date('2026-07-11T05:00:00.000Z') }),
    range
  ), false);

  const invalid = normalizeApplicantDateRange({
    dateFrom: '2026-07-12',
    dateTo: '2026-07-10'
  });
  assert.equal(invalid.isActive, false);
  assert.match(invalid.error, /fecha inicial/i);
});

test('Ver todos filtra incompletos y ordena por fecha de registro descendente', async () => {
  const viewModel = {
    mode: 'legacy',
    candidates: [
      completeCandidate({
        id: 'older',
        createdAt: new Date('2026-07-01T12:00:00.000Z')
      }),
      completeCandidate({
        id: 'incomplete',
        transportMode: null,
        createdAt: new Date('2026-07-09T12:00:00.000Z')
      }),
      completeCandidate({
        id: 'newer',
        cvStorageKey: null,
        cvOriginalName: null,
        cvMimeType: null,
        createdAt: new Date('2026-07-08T12:00:00.000Z')
      })
    ]
  };

  await enhanceLegacyApplicantList(viewModel, {}, {
    userRole: 'admin',
    userAccessScope: 'ALL'
  });

  assert.deepEqual(viewModel.candidates.map((candidate) => candidate.id), ['newer', 'older']);
  assert.equal(compareCandidatesByRegisteredAtDesc(viewModel.candidates[0], viewModel.candidates[1]) < 0, true);
});

test('inyecta inmediatamente el filtro de fechas y corrige enlaces Ver todos por vacante', () => {
  const html = '<html><body><div class="page"><div data-vacancy-panel="vacancy-1"><a href="/admin?status=registered">ver todos</a></div></div></body></html>';
  const output = injectAdminApplicantControls(html, {
    query: { status: 'registered', vacancyId: 'vacancy-1' }
  }, {
    mode: 'legacy',
    applicantDateRange: normalizeApplicantDateRange({})
  });

  assert.match(output, /Postulados desde/);
  assert.match(output, /Postulados hasta/);
  assert.match(output, /Ordenados del registro más reciente al más antiguo/);
  assert.match(output, /data-vacancy-panel/);
  assert.match(output, /vacancyId/);
});
