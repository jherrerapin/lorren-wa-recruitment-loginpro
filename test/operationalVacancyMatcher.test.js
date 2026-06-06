import test from 'node:test';
import assert from 'node:assert/strict';

import { OperationalMatchAction, evaluateOperationalVacancyMatch } from '../src/services/operationalVacancyMatcher.js';

function vacancy(overrides = {}) {
  return {
    id: 'vac-base',
    title: 'Auxiliar de cargue y descargue',
    role: 'Auxiliar operativo',
    city: 'Bogotá',
    operation: { name: 'Operación base', city: { name: 'Bogotá' } },
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

const montevideo = vacancy({
  id: 'vac-montevideo',
  title: 'Auxiliar de cargue y descargue Montevideo',
  operation: { name: 'Montevideo', city: { name: 'Bogotá' } }
});

const siberia = vacancy({
  id: 'vac-siberia',
  title: 'Auxiliar de cargue y descargue Siberia',
  city: 'Siberia',
  operation: { name: 'Siberia', city: { name: 'Siberia' } }
});

test('Bogota como ciudad pide localidad antes de decidir vacante', () => {
  const result = evaluateOperationalVacancyMatch({ residenceText: 'Bogotá', vacancies: [montevideo, siberia] });
  assert.equal(result.action, OperationalMatchAction.NEED_BOGOTA_LOCALITY);
});

test('localidad de Bogota prioriza Montevideo cuando esta activa', () => {
  const result = evaluateOperationalVacancyMatch({ residenceText: 'Kennedy', vacancies: [montevideo, siberia] });
  assert.equal(result.action, OperationalMatchAction.ASSIGN_ACTIVE);
  assert.equal(result.vacancy.id, 'vac-montevideo');
});

test('municipio de Sabana prioriza Siberia y pide transporte si no se conoce', () => {
  const result = evaluateOperationalVacancyMatch({ residenceText: 'Mosquera', vacancies: [montevideo, siberia] });
  assert.equal(result.action, OperationalMatchAction.NEED_SIBERIA_TRANSPORT);
  assert.equal(result.vacancy.id, 'vac-siberia');
});

test('municipio de Sabana con transporte propio asigna Siberia activa', () => {
  const result = evaluateOperationalVacancyMatch({ residenceText: 'Funza', transportMode: 'moto', vacancies: [montevideo, siberia] });
  assert.equal(result.action, OperationalMatchAction.ASSIGN_ACTIVE);
  assert.equal(result.vacancy.id, 'vac-siberia');
});

test('si la mejor vacante esta inactiva y hay alternativa activa, ofrece alternativa sin forzar', () => {
  const inactiveMontevideo = { ...montevideo, isActive: false, acceptingApplications: false };
  const result = evaluateOperationalVacancyMatch({ residenceText: 'Kennedy', vacancies: [inactiveMontevideo, siberia] });
  assert.equal(result.action, OperationalMatchAction.OFFER_ACTIVE_ALTERNATIVE);
  assert.equal(result.vacancy.id, 'vac-montevideo');
  assert.equal(result.activeAlternative.id, 'vac-siberia');
});

test('si la mejor vacante esta inactiva y no hay alternativa activa, asigna registro interno', () => {
  const inactiveMontevideo = { ...montevideo, isActive: false, acceptingApplications: false };
  const inactiveSiberia = { ...siberia, isActive: false, acceptingApplications: false };
  const result = evaluateOperationalVacancyMatch({ residenceText: 'Kennedy', vacancies: [inactiveMontevideo, inactiveSiberia] });
  assert.equal(result.action, OperationalMatchAction.ASSIGN_INACTIVE_REGISTER_ONLY);
  assert.equal(result.vacancy.id, 'vac-montevideo');
});
