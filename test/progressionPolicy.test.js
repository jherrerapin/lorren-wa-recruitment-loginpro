import test from 'node:test';
import assert from 'node:assert/strict';
import { progressionPolicy } from '../src/core/engine/policies/progressionPolicy.js';

function input(overrides = {}) {
  return {
    candidate: {
      facts: {
        dataConsentStatus: 'ACCEPTED',
        currentStep: 'COLLECTING_DATA',
        vacancyId: 'vacancy-1'
      }
    },
    vacancy: { id: 'vacancy-1', schedulingEnabled: true },
    interpretation: { intent: 'PROVIDE_DATA', fields: {} },
    pending: { fields: [], actions: [] },
    attachments: { items: [], current: [], hasCv: false },
    ...overrides
  };
}

test('no progresa antes del consentimiento ni con campos pendientes', async () => {
  assert.deepEqual(await progressionPolicy(input({
    candidate: { facts: { dataConsentStatus: 'PENDING', vacancyId: 'vacancy-1' } }
  })), {});
  assert.deepEqual(await progressionPolicy(input({
    pending: { fields: ['documentNumber'], actions: [] }
  })), { scheduling: null });
});

test('pide la hoja de vida una sola vez cuando los datos ya están completos', async () => {
  const decision = await progressionPolicy(input());
  assert.match(decision.reply.text, /PDF o DOCX/i);
  assert.equal(decision.scheduling, null);
});

test('con hoja de vida y agenda habilitada propone slots', async () => {
  assert.deepEqual(await progressionPolicy(input({
    candidate: {
      facts: {
        dataConsentStatus: 'ACCEPTED',
        currentStep: 'COLLECTING_DATA',
        vacancyId: 'vacancy-1',
        cvStorageKey: 'candidate/hv.pdf'
      }
    }
  })), {
    scheduling: { action: 'suggest_slots' }
  });
});

test('sin agenda habilitada registra el proceso y finaliza limpiamente', async () => {
  const decision = await progressionPolicy(input({
    candidate: {
      facts: {
        dataConsentStatus: 'ACCEPTED',
        currentStep: 'COLLECTING_DATA',
        vacancyId: 'vacancy-1',
        cvStorageKey: 'candidate/hv.pdf'
      }
    },
    vacancy: { id: 'vacancy-1', schedulingEnabled: false }
  }));
  assert.equal(decision.transitions.endConversation, true);
  assert.match(decision.reply.text, /información y hoja de vida quedaron registradas/i);
});
