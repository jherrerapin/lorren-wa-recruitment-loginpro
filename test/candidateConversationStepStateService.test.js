import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep } from '@prisma/client';
import { transitionCandidateConversationStep } from '../src/services/candidateStateService.js';

function createHarness(initialCandidate) {
  let state = initialCandidate ? { ...initialCandidate } : null;
  const calls = { updateMany: [], findUnique: [], transactions: 0 };

  const client = {
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        if (!state || state.id !== args.where.id || state.currentStep !== args.where.currentStep) {
          return { count: 0 };
        }
        state = { ...state, ...args.data };
        return { count: 1 };
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return state && state.id === args.where.id ? { ...state } : null;
      }
    },
    $transaction: async () => {
      calls.transactions += 1;
      throw new Error('nested_transaction_not_allowed');
    }
  };

  return {
    client,
    calls,
    getState: () => (state ? { ...state } : null),
    setState: (next) => { state = next ? { ...next } : null; }
  };
}

const candidate = {
  id: 'candidate-step-1',
  currentStep: ConversationStep.COLLECTING_DATA
};

test('aplica una transición simple únicamente cuando coincide el paso esperado', async () => {
  const { client, calls, getState } = createHarness(candidate);

  const result = await transitionCandidateConversationStep(client, {
    candidateId: candidate.id,
    expected: { currentStep: ConversationStep.COLLECTING_DATA },
    nextStep: ConversationStep.CONFIRMING_DATA
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.currentStep, ConversationStep.CONFIRMING_DATA);
  assert.equal(getState().currentStep, ConversationStep.CONFIRMING_DATA);
  assert.deepEqual(calls.updateMany[0], {
    where: {
      id: candidate.id,
      currentStep: ConversationStep.COLLECTING_DATA
    },
    data: {
      currentStep: ConversationStep.CONFIRMING_DATA
    }
  });
  assert.equal(calls.findUnique.length, 1);
  assert.equal(calls.transactions, 0);
});

test('una carrera devuelve count cero y preserva el paso vigente', async () => {
  const { client, calls, setState, getState } = createHarness(candidate);
  setState({ ...candidate, currentStep: ConversationStep.ASK_CV });

  const result = await transitionCandidateConversationStep(client, {
    candidateId: candidate.id,
    expected: { currentStep: ConversationStep.COLLECTING_DATA },
    nextStep: ConversationStep.CONFIRMING_DATA
  });

  assert.equal(result.count, 0);
  assert.equal(result.candidate.currentStep, ConversationStep.ASK_CV);
  assert.equal(getState().currentStep, ConversationStep.ASK_CV);
  assert.equal(calls.updateMany.length, 1);
  assert.equal(calls.findUnique.length, 1);
  assert.equal(calls.transactions, 0);
});

test('rechaza cliente, id, pasos desconocidos y transición no-op', async () => {
  await assert.rejects(
    () => transitionCandidateConversationStep(null, {}),
    /candidate_state_client_required/
  );

  const { client } = createHarness(candidate);
  await assert.rejects(
    () => transitionCandidateConversationStep(client, {
      candidateId: ' ',
      expected: { currentStep: ConversationStep.COLLECTING_DATA },
      nextStep: ConversationStep.ASK_CV
    }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => transitionCandidateConversationStep(client, {
      candidateId: candidate.id,
      expected: { currentStep: 'UNKNOWN_STEP' },
      nextStep: ConversationStep.ASK_CV
    }),
    /candidate_expected_current_step_invalid/
  );
  await assert.rejects(
    () => transitionCandidateConversationStep(client, {
      candidateId: candidate.id,
      expected: { currentStep: ConversationStep.COLLECTING_DATA },
      nextStep: ['ASK_CV']
    }),
    /candidate_next_step_invalid/
  );
  await assert.rejects(
    () => transitionCandidateConversationStep(client, {
      candidateId: candidate.id,
      expected: { currentStep: ConversationStep.COLLECTING_DATA },
      nextStep: ConversationStep.COLLECTING_DATA
    }),
    /candidate_conversation_step_noop/
  );
});
