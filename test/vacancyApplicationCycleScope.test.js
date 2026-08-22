import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVacancyApplicationCycleScript,
  normalizeVacancyHistoryScopes,
  resolveVacancyApplicationCycleStartedAt,
  scopeVacancyToApplicationCycle
} from '../src/services/vacancyDashboardSearchExpansion.js';

function candidate(id, createdAt) {
  return { id, createdAt: new Date(createdAt) };
}

function vacancy(overrides = {}) {
  return {
    id: 'vacancy-cycle-test',
    bookingsToday: [],
    registeredNoBooking: [],
    registeredComplete: [],
    completeWithoutCv: [],
    approvedCandidates: [],
    contractedCandidates: [],
    ...overrides
  };
}

test('el ciclo inicia en la última transición real de no abierta a abierta, no en una edición abierta', () => {
  const events = [
    {
      entityId: 'vacancy-cycle-test',
      action: 'VACANCY_UPDATED',
      createdAt: new Date('2026-08-22T19:45:00.000Z'),
      fromValue: { isActive: true, acceptingApplications: true },
      toValue: { isActive: true, acceptingApplications: true }
    },
    {
      entityId: 'vacancy-cycle-test',
      action: 'VACANCY_FLOW_TOGGLED',
      createdAt: new Date('2026-08-22T19:30:00.000Z'),
      fromValue: { isActive: true, acceptingApplications: false },
      toValue: { isActive: true, acceptingApplications: true }
    },
    {
      entityId: 'vacancy-cycle-test',
      action: 'VACANCY_CREATED',
      createdAt: new Date('2026-08-20T14:00:00.000Z'),
      fromValue: null,
      toValue: { isActive: true, acceptingApplications: true }
    }
  ];

  const startedAt = resolveVacancyApplicationCycleStartedAt(events, 'vacancy-cycle-test');
  assert.equal(startedAt?.toISOString(), '2026-08-22T19:30:00.000Z');
});

test('una vacante histórica sin transición auditada no inventa un corte de ciclo', () => {
  const startedAt = resolveVacancyApplicationCycleStartedAt([
    {
      entityId: 'vacancy-cycle-test',
      action: 'VACANCY_UPDATED',
      createdAt: new Date('2026-08-22T19:45:00.000Z'),
      fromValue: { isActive: true, acceptingApplications: true },
      toValue: { isActive: true, acceptingApplications: true }
    }
  ], 'vacancy-cycle-test');

  assert.equal(startedAt, null);
});

test('el alcance del ciclo oculta históricos sin borrar agenda ni duplicar postulaciones en el contador', () => {
  const oldCandidate = candidate('candidate-old', '2026-08-22T18:59:59.000Z');
  const newCandidate = candidate('candidate-new', '2026-08-22T19:30:01.000Z');
  const model = vacancy({
    bookingsToday: [{ id: 'booking-old', candidate: oldCandidate }],
    registeredNoBooking: [oldCandidate, newCandidate],
    completeWithoutCv: [newCandidate],
    approvedCandidates: [oldCandidate]
  });

  const metadata = scopeVacancyToApplicationCycle(
    model,
    new Date('2026-08-22T19:30:00.000Z')
  );

  assert.deepEqual(model.registeredNoBooking.map((item) => item.id), ['candidate-new']);
  assert.deepEqual(model.completeWithoutCv.map((item) => item.id), ['candidate-new']);
  assert.deepEqual(model.approvedCandidates, []);
  assert.equal(model.bookingsToday.length, 1);
  assert.equal(metadata.historicalCandidateCount, 2);
  assert.equal(metadata.visibleCandidateCount, 1);
});

test('Ver todos los registros restaura el histórico de la vacante sin mutar candidatos', () => {
  const oldCandidate = candidate('candidate-old', '2026-08-22T18:00:00.000Z');
  const newCandidate = candidate('candidate-new', '2026-08-22T20:00:00.000Z');
  const model = vacancy({ registeredNoBooking: [oldCandidate, newCandidate] });

  const metadata = scopeVacancyToApplicationCycle(
    model,
    new Date('2026-08-22T19:30:00.000Z'),
    { showHistory: true }
  );

  assert.deepEqual(model.registeredNoBooking.map((item) => item.id), ['candidate-old', 'candidate-new']);
  assert.equal(metadata.showHistory, true);
  assert.equal(metadata.visibleCandidateCount, 2);
});

test('el query de histórico es independiente por vacante', () => {
  const scopes = normalizeVacancyHistoryScopes({
    'vh_vacancy-a': 'all',
    'vh_vacancy-b': 'current',
    'vh_vacancy-c': ['all']
  });

  assert.deepEqual([...scopes].sort(), ['vacancy-a', 'vacancy-c']);
});

test('el control de interfaz ofrece histórico y regreso al ciclo actual', () => {
  const currentScript = buildVacancyApplicationCycleScript({
    'vacancy-cycle-test': {
      vacancyId: 'vacancy-cycle-test',
      cityName: 'Ciudad Prueba',
      cycleStartedAt: '2026-08-22T19:30:00.000Z',
      showHistory: false,
      historicalCandidateCount: 4,
      visibleCandidateCount: 1
    }
  });
  assert.match(currentScript, /Ver todos los registros/);
  assert.match(currentScript, /Ciclo actual/);
  assert.match(currentScript, /vh_/);
  assert.match(currentScript, /visibleCandidateCount/);

  const historyScript = buildVacancyApplicationCycleScript({
    'vacancy-cycle-test': {
      vacancyId: 'vacancy-cycle-test',
      cityName: 'Ciudad Prueba',
      cycleStartedAt: '2026-08-22T19:30:00.000Z',
      showHistory: true,
      historicalCandidateCount: 4,
      visibleCandidateCount: 4
    }
  });
  assert.match(historyScript, /Ver ciclo actual/);
  assert.match(historyScript, /Histórico visible/);
});
