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

const allVacancies = [ibagueLeaderVacancy, bogotaAuxVacancy];
const activeVacancies = allVacancies.filter((vacancy) => vacancy.isActive && vacancy.acceptingApplications);

async function resolveText(text) {
  return resolveVacancyFromText({}, text, { allVacancies, activeVacancies });
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

test('vacancyFirstGate asigna la vacante de liderazgo y no pide referencia adicional', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: {},
    candidate: { currentStep: 'GREETING_SENT' },
    currentVacancy: null,
    inboundText: 'Hola, de Ibagué\nLíder logístico',
    currentStep: 'GREETING_SENT',
    recentMessages: [
      { direction: 'INBOUND', body: '¡Hola! Quiero más información.' }
    ],
    vacancyHints: { allVacancies, activeVacancies }
  });

  assert.equal(decision.action, VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE);
  assert.equal(decision.vacancyId, ibagueLeaderVacancy.id);
  assert.notEqual(decision.replyKind, 'ASK_CITY_LOCALITY_AND_ROLE');
  assert.ok(!String(decision.reply || '').toLowerCase().includes('referencia adicional'));
});
