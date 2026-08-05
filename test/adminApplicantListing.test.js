import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateMatchesApplicantDateRange,
  compareCandidatesByRegisteredAtDesc,
  enhanceAdminApplicantListView,
  injectAdminApplicantControls,
  normalizeApplicantDateRange
} from '../src/services/adminApplicantListing.js';

test('ordena postulados por fecha de registro aunque un candidato antiguo tenga actividad reciente', () => {
  const candidates = [
    {
      id: 'antiguo',
      createdAt: new Date('2026-07-01T15:00:00.000Z'),
      lastInboundAt: new Date('2026-08-05T20:00:00.000Z')
    },
    {
      id: 'reciente',
      createdAt: new Date('2026-08-05T14:00:00.000Z'),
      lastInboundAt: new Date('2026-08-05T14:00:00.000Z')
    }
  ];

  candidates.sort(compareCandidatesByRegisteredAtDesc);

  assert.deepEqual(candidates.map((candidate) => candidate.id), ['reciente', 'antiguo']);
});

test('interpreta el rango completo usando los límites horarios de Colombia', () => {
  const range = normalizeApplicantDateRange({
    dateFrom: '2026-08-01',
    dateTo: '2026-08-03'
  });

  assert.equal(range.error, null);
  assert.equal(range.start.toISOString(), '2026-08-01T05:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-08-04T04:59:59.999Z');
  assert.equal(candidateMatchesApplicantDateRange({ createdAt: '2026-08-01T05:00:00.000Z' }, range), true);
  assert.equal(candidateMatchesApplicantDateRange({ createdAt: '2026-08-04T04:59:59.999Z' }, range), true);
  assert.equal(candidateMatchesApplicantDateRange({ createdAt: '2026-08-04T05:00:00.000Z' }, range), false);
});

test('rechaza un rango cuya fecha inicial sea posterior a la fecha final', () => {
  const range = normalizeApplicantDateRange({
    dateFrom: '2026-08-05',
    dateTo: '2026-08-01'
  });

  assert.equal(range.isActive, false);
  assert.equal(range.start, null);
  assert.equal(range.end, null);
  assert.match(range.error, /fecha inicial/i);
});

test('la vista todos conserva únicamente candidatos de la vacante solicitada y los ordena por registro', async () => {
  const prisma = {
    candidate: {
      findMany: async () => [{ id: 'vacancy-new' }, { id: 'vacancy-old' }]
    }
  };
  const req = {
    query: {
      status: 'all',
      vacancyId: 'vacancy-1',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-05'
    }
  };
  const locals = {
    mode: 'legacy',
    candidates: [
      { id: 'other-vacancy', createdAt: '2026-08-05T16:00:00.000Z' },
      { id: 'vacancy-old', createdAt: '2026-08-01T12:00:00.000Z' },
      { id: 'vacancy-new', createdAt: '2026-08-04T12:00:00.000Z' }
    ]
  };

  const enhanced = await enhanceAdminApplicantListView(prisma, req, locals);

  assert.deepEqual(enhanced.candidates.map((candidate) => candidate.id), ['vacancy-new', 'vacancy-old']);
});

test('el panel por vacante filtra y ordena cada lista sin alterar entrevistas', async () => {
  const req = { query: { dateFrom: '2026-08-03', dateTo: '2026-08-05' } };
  const locals = {
    mode: 'vacancies',
    cities: [{
      name: 'Medellín',
      vacancies: [{
        id: 'vacancy-1',
        bookingsToday: [{ id: 'booking-1' }],
        registeredComplete: [
          { id: 'older', createdAt: '2026-08-01T12:00:00.000Z' },
          { id: 'newest', createdAt: '2026-08-05T12:00:00.000Z' },
          { id: 'middle', createdAt: '2026-08-04T12:00:00.000Z' }
        ],
        registeredNoBooking: [],
        completeWithoutCv: [],
        approvedCandidates: [],
        contractedCandidates: []
      }]
    }]
  };

  const enhanced = await enhanceAdminApplicantListView({}, req, locals);
  const vacancy = enhanced.cities[0].vacancies[0];

  assert.deepEqual(vacancy.registeredComplete.map((candidate) => candidate.id), ['newest', 'middle']);
  assert.deepEqual(vacancy.bookingsToday, [{ id: 'booking-1' }]);
});

test('inyecta controles de fecha y corrige enlaces ver todos por vacante', () => {
  const html = '<html><body><div class="page"><div data-vacancy-panel="vacancy-1"><a href="/admin?status=registered">ver todos</a></div></div></body></html>';
  const output = injectAdminApplicantControls(html, {
    query: { city: 'Medellín', dateFrom: '2026-08-01', dateTo: '2026-08-05' }
  });

  assert.match(output, /Postulados desde/);
  assert.match(output, /name="dateFrom" value="2026-08-01"/);
  assert.match(output, /url\.searchParams\.set\('vacancyId', vacancyId\)/);
  assert.match(output, /dateFrom/);
});
