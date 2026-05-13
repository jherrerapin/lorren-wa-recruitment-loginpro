import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRoleHintFromText, resolveVacancyFromText } from '../src/services/vacancyResolver.js';

const operation = {
  id: 'op-ibague',
  name: 'Operacion Ibague',
  city: { id: 'city-ibague', name: 'Ibague' }
};

const activeIbagueVacancy = {
  id: 'vac-iba-1',
  title: 'Auxiliar de Cargue y Descargue Ibague',
  role: 'Auxiliar de cargue y descargue',
  city: 'Ibague',
  operation,
  operationAddress: 'Zona industrial',
  isActive: true,
  acceptingApplications: true
};

test('detectRoleHintFromText ignora expresiones genericas de vacante de trabajo', () => {
  const roleHint = detectRoleHintFromText('vacante de trabajo', { city: 'Ibague' });
  assert.equal(roleHint, null);
});

test('resolveVacancyFromText no autoasigna vacante cuando solo detecta ciudad', async () => {
  const resolution = await resolveVacancyFromText(null, 'Buenas noches te escribo desde Ibague para vacante de trabajo', {
    activeVacancies: [activeIbagueVacancy],
    allVacancies: [activeIbagueVacancy]
  });

  assert.equal(resolution.resolved, false);
  assert.equal(resolution.city, 'Ibague');
  assert.equal(resolution.reason, 'city_with_active_vacancies');
});

test('resolveVacancyFromText no cruza a otra ciudad aunque el cargo coincida', async () => {
  const resolution = await resolveVacancyFromText(null, 'Estoy en Bogota y me interesa auxiliar de cargue y descargue', {
    activeVacancies: [activeIbagueVacancy],
    allVacancies: [activeIbagueVacancy]
  });

  assert.equal(resolution.resolved, false);
  assert.equal(resolution.city, 'Bogota');
  assert.equal(resolution.reason, 'city_without_active_vacancies');
});

const bogotaOperation = {
  id: 'op-bogota',
  name: 'Operacion Bogota',
  city: { id: 'city-bogota', name: 'Bogota' }
};

const activeBogotaBodegaVacancy = {
  id: 'vac-bog-bodega',
  title: 'Auxiliar de Bodega Bogota',
  role: 'Auxiliar de bodega',
  city: 'Bogota',
  operation: bogotaOperation,
  operationAddress: 'Bogota',
  isActive: true,
  acceptingApplications: true
};

const inactiveSiberiaBodegaVacancy = {
  id: 'vac-sib-bodega',
  title: 'Auxiliar de Bodega Siberia',
  role: 'Auxiliar de bodega',
  city: 'Bogota',
  operation: bogotaOperation,
  operationAddress: 'Siberia',
  isActive: true,
  acceptingApplications: false
};

const inactiveIbagueCoordinatorVacancy = {
  id: 'vac-iba-coord-inactive',
  title: 'Coordinador de Operaciones Ibague',
  role: 'Coordinador de operaciones',
  city: 'Ibague',
  operation,
  operationAddress: 'Zona aeropuerto',
  isActive: true,
  acceptingApplications: false
};

test('resolveVacancyFromText prioriza vacante activa de la ciudad sobre inactiva de zona aliada', async () => {
  const resolution = await resolveVacancyFromText(null, 'Estoy en Bogota y me interesa auxiliar de bodega', {
    activeVacancies: [activeBogotaBodegaVacancy],
    allVacancies: [inactiveSiberiaBodegaVacancy, activeBogotaBodegaVacancy]
  });

  assert.equal(resolution.resolved, true);
  assert.equal(resolution.vacancy.id, 'vac-bog-bodega');
  assert.equal(resolution.reason, 'matched_active_vacancy');
});

test('resolveVacancyFromText solo usa inactiva si las activas de la ciudad no coinciden con el cargo', async () => {
  const resolution = await resolveVacancyFromText(null, 'Estoy en Ibague y me interesa coordinador de operaciones', {
    activeVacancies: [activeIbagueVacancy],
    allVacancies: [activeIbagueVacancy, inactiveIbagueCoordinatorVacancy]
  });

  assert.equal(resolution.resolved, true);
  assert.equal(resolution.vacancy.id, 'vac-iba-coord-inactive');
  assert.equal(resolution.reason, 'matched_inactive_vacancy');
});
