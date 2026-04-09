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
