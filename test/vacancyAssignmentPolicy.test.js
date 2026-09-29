import test from 'node:test';
import assert from 'node:assert/strict';
import { vacancyAssignmentPolicy } from '../src/core/engine/policies/vacancyAssignmentPolicy.js';

function input(overrides = {}) {
  return {
    turn: { rawText: '' },
    candidate: { facts: {} },
    vacancy: {
      id: 'vacancy-bodega-bogota',
      title: 'Auxiliar de bodega',
      role: 'Cargue y descargue',
      city: 'Bogotá'
    },
    interpretation: { intent: 'APPLY_INTENT' },
    ...overrides
  };
}

test('interés explícito asigna la vacante ya resuelta por la envoltura', async () => {
  assert.deepEqual(await vacancyAssignmentPolicy(input()), {
    mutations: {
      fieldsToPersist: { vacancyId: 'vacancy-bodega-bogota' }
    }
  });
});

test('mencionar solo una ciudad no asigna una vacante por aproximación', async () => {
  assert.deepEqual(await vacancyAssignmentPolicy(input({
    turn: { rawText: 'Vivo en Bogotá' },
    interpretation: { intent: 'PROVIDE_DATA' }
  })), {});
});

test('datos con evidencia del cargo permiten materializar la resolución previa', async () => {
  assert.deepEqual(await vacancyAssignmentPolicy(input({
    turn: { rawText: 'Tengo experiencia en cargue y descargue' },
    interpretation: { intent: 'PROVIDE_DATA' }
  })), {
    mutations: {
      fieldsToPersist: { vacancyId: 'vacancy-bodega-bogota' }
    }
  });
});

test('nunca reemplaza una vacante que ya está consolidada en el candidato', async () => {
  assert.deepEqual(await vacancyAssignmentPolicy(input({
    candidate: { facts: { vacancyId: 'vacancy-existing' } }
  })), {});
});
