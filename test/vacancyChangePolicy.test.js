import test from 'node:test';
import { strict as assert } from 'node:assert';
import { vacancyChangePolicy } from '../src/core/engine/policies/vacancyChangePolicy.js';

test('CHANGE_VACANCY solicita el cargo y no hereda el anterior cuando solo se provee ciudad', async () => {
  const input = {
    turn: { rawText: 'Quiero otra vacante en Medellín' },
    interpretation: {
      intent: 'CHANGE_VACANCY',
      fields: {
        city: 'Medellín',
        role: null
      }
    },
    candidate: { facts: { vacancyId: 'vacante-vieja-bogota' } },
    vacancy: {
      id: 'vac-medellin-cargue',
      role: 'auxiliar cargue descargue',
      operation: { city: { name: 'Medellín' } }
    },
    execution: { mayReply: true }
  };

  const decision = await vacancyChangePolicy(input);

  assert.equal(
    decision.transitions?.some((transition) => transition.type === 'assign_vacancy'),
    undefined
  );
  assert.match(
    decision.reply?.text,
    /Ya tengo la ciudad Medellín\. Para cambiar tu proceso.*dime el cargo exacto/
  );
});
