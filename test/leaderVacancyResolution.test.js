import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveVacancyFromText } from '../src/services/vacancyResolver.js';
import { resolveVacancyFirstGate, VacancyFirstGateAction } from '../src/services/vacancyFirstGate.js';

const ibagueLeaderVacancy = {
  id: 'vac-ibague-lider-operaciones',
  title: 'Lider de Operaciones en Ibague - Zona aeropuerto',
  role: 'Lider de Operaciones',
  roleDescription: 'Liderar equipos de trabajo y coordinar procesos logisticos y operativos.',
  requirements: 'Experiencia liderando equipos logisticos u operativos.',
  conditions: 'Operacion logistica en zona aeropuerto de Ibague.',
  requiredDocuments: 'Hoja de vida y documento de identidad.',
  operationAddress: 'Zona aeropuerto',
  city: 'Ibague',
  isActive: true,
  acceptingApplications: true,
  operation: {
    name: 'Zona aeropuerto',
    city: { name: 'Ibague' }
  }
};

const ibagueAuxVacancy = {
  id: 'vac-ibague-auxiliar',
  title: 'Auxiliar de cargue y descargue Ibague',
  role: 'Auxiliar de cargue y descargue',
  roleDescription: 'Apoyo operativo en bodega, cargue y descargue.',
  city: 'Ibague',
  isActive: true,
  acceptingApplications: true,
  operation: {
    name: 'Zona aeropuerto',
    city: { name: 'Ibague' }
  }
};

const bogotaAuxVacancy = {
  id: 'vac-bogota-auxiliar',
  title: 'Auxiliar de cargue y descargue Bogota',
  role: 'Auxiliar de cargue y descargue',
  roleDescription: 'Apoyo operativo en bodega, cargue y descargue.',
  city: 'Bogota',
  isActive: true,
  acceptingApplications: true,
  operation: {
    name: 'Montevideo',
    city: { name: 'Bogota' }
  }
};

const allVacancies = [ibagueLeaderVacancy, ibagueAuxVacancy, bogotaAuxVacancy];
const activeVacancies = allVacancies.filter((vacancy) => vacancy.isActive && vacancy.acceptingApplications);

async function resolveText(text, options = {}) {
  return resolveVacancyFromText({}, text, { allVacancies, activeVacancies, ...options });
}

async function decideGate({ text, vacancyHints = {}, recentMessages = [] }) {
  return resolveVacancyFirstGate({
    prisma: {},
    candidate: { currentStep: 'GREETING_SENT' },
    currentVacancy: null,
    inboundText: text,
    currentStep: 'GREETING_SENT',
    recentMessages,
    vacancyHints: { allVacancies, activeVacancies, ...vacancyHints }
  });
}

test('Ibagué + líder logístico resuelve Lider de Operaciones sin pedir referencia adicional', async () => {
  const result = await resolveText('Hola, de Ibagué\nLíder logístico');

  assert.equal(result.resolved, true);
  assert.equal(result.vacancy.id, ibagueLeaderVacancy.id);
  assert.equal(result.reason, 'matched_active_vacancy');
  assert.notEqual(result.reason, 'city_with_active_vacancies');
  assert.notEqual(result.reason, 'low_confidence_match');
});

test('Ibagué + líder operativo resuelve Lider de Operaciones', async () => {
  const result = await resolveText('Ibagué\nLíder operativo');

  assert.equal(result.resolved, true);
  assert.equal(result.vacancy.id, ibagueLeaderVacancy.id);
  assert.equal(result.reason, 'matched_active_vacancy');
});

test('Ibagué + líder de operaciones resuelve Lider de Operaciones', async () => {
  const result = await resolveText('Ibagué líder de operaciones');

  assert.equal(result.resolved, true);
  assert.equal(result.vacancy.id, ibagueLeaderVacancy.id);
  assert.equal(result.reason, 'matched_active_vacancy');
});

test('Ibagué + coordinador/líder con typo operativo resuelve Lider de Operaciones', async () => {
  const result = await resolveText('Ibague\nCoordinador l\nLíder de optaciones');

  assert.equal(result.resolved, true);
  assert.equal(result.vacancy.id, ibagueLeaderVacancy.id);
  assert.equal(result.reason, 'matched_active_vacancy');
  assert.match(result.roleHint, /operaciones/);
});

test('roleHint parcial de IA no debe tapar la intención completa escrita por el candidato', async () => {
  const result = await resolveText('Ibague\nCoordinador l\nLíder de optaciones', {
    cityHint: 'Ibague',
    roleHint: 'coordinador'
  });

  assert.equal(result.resolved, true);
  assert.equal(result.vacancy.id, ibagueLeaderVacancy.id);
  assert.equal(result.reason, 'matched_active_vacancy');
  assert.match(result.roleHint, /coordinador/);
  assert.match(result.roleHint, /lider/);
  assert.match(result.roleHint, /operaciones/);
});

test('roleHint externo equivocado hacia auxiliar no derrota evidencia local de liderazgo', async () => {
  const result = await resolveText('Ibague\nLider de optaciones', {
    cityHint: 'Ibague',
    roleHint: 'auxiliar'
  });

  assert.equal(result.resolved, true);
  assert.equal(result.vacancy.id, ibagueLeaderVacancy.id);
  assert.notEqual(result.vacancy.id, ibagueAuxVacancy.id);
  assert.match(result.roleHint, /auxiliar/);
  assert.match(result.roleHint, /lider/);
  assert.match(result.roleHint, /operaciones/);
});

test('solo ciudad Ibagué no asigna automáticamente la vacante de liderazgo', async () => {
  const result = await resolveText('Ibague');

  assert.equal(result.resolved, false);
  assert.equal(result.vacancy, null);
  assert.equal(result.city, 'Ibague');
  assert.equal(result.reason, 'city_with_active_vacancies');
});

test('Bogotá auxiliar de cargue conserva la ciudad y no salta a Lider de Operaciones Ibagué', async () => {
  const result = await resolveText('Bogotá auxiliar de cargue y descargue');

  assert.equal(result.resolved, true);
  assert.equal(result.vacancy.id, bogotaAuxVacancy.id);
  assert.notEqual(result.vacancy.id, ibagueLeaderVacancy.id);
  assert.equal(result.reason, 'matched_active_vacancy');
});

test('vacancyFirstGate asigna la vacante de liderazgo y no pide referencia adicional', async () => {
  const decision = await decideGate({
    text: 'Hola, de Ibagué\nLíder logístico',
    recentMessages: [
      { direction: 'INBOUND', body: '¡Hola! Quiero más información.' }
    ]
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, ibagueLeaderVacancy.id);
  assert.notEqual(decision.replyKind, 'ASK_CITY_LOCALITY_AND_ROLE');
  assert.ok(!String(decision.reply || '').toLowerCase().includes('referencia adicional'));
});

test('vacancyFirstGate no ofrece auxiliar si existe Lider de Operaciones activo para el texto con typo', async () => {
  const decision = await decideGate({
    text: 'Ibague\nCoordinador l\nLíder de optaciones',
    recentMessages: [
      { direction: 'INBOUND', body: 'Ibague' },
      { direction: 'INBOUND', body: 'Tolima' }
    ],
    vacancyHints: {
      city: 'Ibague',
      roleHint: 'coordinador'
    }
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, ibagueLeaderVacancy.id);
  assert.notEqual(decision.vacancyId, ibagueAuxVacancy.id);
  assert.notEqual(decision.replyKind, 'ALTERNATIVE_VACANCY_OFFER');
});

test('vacancyFirstGate usa ciudad del contexto reciente cuando el cargo llega en mensaje separado', async () => {
  const decision = await decideGate({
    text: 'Coordinador l\nLíder de optaciones',
    recentMessages: [
      { direction: 'INBOUND', body: '¡Hola! Quiero más información.' },
      { direction: 'INBOUND', body: 'Ibague' },
      { direction: 'INBOUND', body: 'Tolima' }
    ],
    vacancyHints: {
      roleHint: 'coordinador'
    }
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, ibagueLeaderVacancy.id);
  assert.notEqual(decision.replyKind, 'ASK_CITY_LOCALITY_AND_ROLE');
  assert.notEqual(decision.replyKind, 'ALTERNATIVE_VACANCY_OFFER');
});
