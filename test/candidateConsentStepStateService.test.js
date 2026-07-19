import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep } from '@prisma/client';
import { transitionCandidateConsentStep } from '../src/services/candidateStateService.js';

function createClient({ persistedStep = ConversationStep.GREETING_SENT, count = 1 } = {}) {
  const calls = { updateMany: [], findUnique: [], transactions: 0 };
  let currentStep = persistedStep;
  const client = {
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        if (count === 1) currentStep = args.data.currentStep;
        return { count };
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return { id: args.where.id, currentStep };
      }
    }
  };
  return { client, calls };
}

test('transiciona aceptación con compare-and-set de currentStep', async () => {
  const { client, calls } = createClient();
  const result = await transitionCandidateConsentStep(client, {
    candidateId: 'candidate-consent-step-1',
    expected: { currentStep: ConversationStep.GREETING_SENT },
    nextStep: ConversationStep.COLLECTING_DATA
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.currentStep, ConversationStep.COLLECTING_DATA);
  assert.deepEqual(calls.updateMany[0], {
    where: {
      id: 'candidate-consent-step-1',
      currentStep: ConversationStep.GREETING_SENT
    },
    data: { currentStep: ConversationStep.COLLECTING_DATA }
  });
});

test('permite el mismo paso para registrar un nuevo evento de consentimiento', async () => {
  const { client } = createClient({ persistedStep: ConversationStep.COLLECTING_DATA });
  const result = await transitionCandidateConsentStep(client, {
    candidateId: 'candidate-consent-step-2',
    expected: { currentStep: ConversationStep.COLLECTING_DATA },
    nextStep: ConversationStep.COLLECTING_DATA
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.currentStep, ConversationStep.COLLECTING_DATA);
});

test('una carrera devuelve count cero y preserva el paso observado', async () => {
  const { client } = createClient({ persistedStep: ConversationStep.ASK_CV, count: 0 });
  const result = await transitionCandidateConsentStep(client, {
    candidateId: 'candidate-consent-step-3',
    expected: { currentStep: ConversationStep.GREETING_SENT },
    nextStep: ConversationStep.COLLECTING_DATA
  });

  assert.equal(result.count, 0);
  assert.equal(result.candidate.currentStep, ConversationStep.ASK_CV);
});

test('acepta únicamente destinos producidos por consentimiento', async () => {
  const { client, calls } = createClient();
  for (const nextStep of [
    ConversationStep.COLLECTING_DATA,
    ConversationStep.GREETING_SENT,
    ConversationStep.DONE
  ]) {
    await transitionCandidateConsentStep(client, {
      candidateId: `candidate-${nextStep}`,
      expected: { currentStep: ConversationStep.GREETING_SENT },
      nextStep
    });
  }
  assert.equal(calls.updateMany.length, 3);

  await assert.rejects(
    () => transitionCandidateConsentStep(client, {
      candidateId: 'candidate-invalid-destination',
      expected: { currentStep: ConversationStep.GREETING_SENT },
      nextStep: ConversationStep.SCHEDULING
    }),
    /candidate_consent_next_step_invalid/
  );
});

test('rechaza clientes, IDs y snapshots inválidos sin abrir transacciones', async () => {
  await assert.rejects(
    () => transitionCandidateConsentStep({}, {
      candidateId: 'candidate-invalid-client',
      expected: { currentStep: ConversationStep.MENU },
      nextStep: ConversationStep.DONE
    }),
    /candidate_state_client_required/
  );

  const { client, calls } = createClient();
  await assert.rejects(
    () => transitionCandidateConsentStep(client, {
      candidateId: '   ',
      expected: { currentStep: ConversationStep.MENU },
      nextStep: ConversationStep.DONE
    }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => transitionCandidateConsentStep(client, {
      candidateId: 'candidate-invalid-snapshot',
      expected: { currentStep: 'INVALID' },
      nextStep: ConversationStep.DONE
    }),
    /candidate_consent_expected_current_step_invalid/
  );

  assert.equal(Object.hasOwn(client, '$transaction'), false);
  assert.equal(calls.transactions, 0);
});
