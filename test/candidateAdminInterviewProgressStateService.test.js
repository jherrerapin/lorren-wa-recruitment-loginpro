import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep } from '@prisma/client';
import {
  CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS,
  reflectCandidateAdminInterviewProgress
} from '../src/services/candidateStateService.js';

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
  id: 'candidate-admin-interview-1',
  currentStep: ConversationStep.CONFIRMING_DATA
};

test('la creación manual de reserva fija SCHEDULED mediante CAS', async () => {
  const { client, calls, getState } = createHarness(candidate);
  const result = await reflectCandidateAdminInterviewProgress(client, {
    candidateId: candidate.id,
    action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
    expected: { currentStep: ConversationStep.CONFIRMING_DATA },
    actor: 'devloginpro',
    reason: 'Entrevista asignada manualmente'
  });

  assert.equal(result.count, 1);
  assert.equal(result.nextStep, ConversationStep.SCHEDULED);
  assert.equal(result.candidate.currentStep, ConversationStep.SCHEDULED);
  assert.equal(getState().currentStep, ConversationStep.SCHEDULED);
  assert.deepEqual(calls.updateMany[0], {
    where: {
      id: candidate.id,
      currentStep: ConversationStep.CONFIRMING_DATA
    },
    data: { currentStep: ConversationStep.SCHEDULED }
  });
  assert.equal(calls.transactions, 0);
});

test('eliminar la última reserva fija SCHEDULING y reutiliza un cliente tx', async () => {
  const txHarness = createHarness({
    id: candidate.id,
    currentStep: ConversationStep.SCHEDULED
  });
  const result = await reflectCandidateAdminInterviewProgress(txHarness.client, {
    candidateId: candidate.id,
    action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.LAST_BOOKING_DELETED,
    expected: { currentStep: ConversationStep.SCHEDULED },
    actor: 'devloginpro',
    reason: 'Última reserva eliminada'
  });

  assert.equal(result.count, 1);
  assert.equal(result.nextStep, ConversationStep.SCHEDULING);
  assert.equal(txHarness.getState().currentStep, ConversationStep.SCHEDULING);
  assert.equal(txHarness.calls.transactions, 0);
});

test('una carrera devuelve count cero y conserva el paso observado', async () => {
  const { client, setState, getState } = createHarness(candidate);
  setState({ ...candidate, currentStep: ConversationStep.ASK_CV });

  const result = await reflectCandidateAdminInterviewProgress(client, {
    candidateId: candidate.id,
    action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
    expected: { currentStep: ConversationStep.CONFIRMING_DATA },
    actor: 'devloginpro',
    reason: 'Entrevista asignada manualmente'
  });

  assert.equal(result.count, 0);
  assert.equal(result.candidate.currentStep, ConversationStep.ASK_CV);
  assert.equal(getState().currentStep, ConversationStep.ASK_CV);
});

test('rechaza acción, snapshot, actor, motivo y nextStep arbitrario', async () => {
  const { client } = createHarness(candidate);

  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(null, {}),
    /candidate_state_client_required/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: 'UNKNOWN',
      expected: { currentStep: ConversationStep.CONFIRMING_DATA },
      actor: 'dev',
      reason: 'test'
    }),
    /candidate_admin_interview_action_invalid/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
      expected: { currentStep: 'UNKNOWN_STEP' },
      actor: 'dev',
      reason: 'test'
    }),
    /candidate_admin_interview_expected_current_step_invalid/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
      expected: { currentStep: ConversationStep.CONFIRMING_DATA },
      actor: ' ',
      reason: 'test'
    }),
    /candidate_admin_interview_actor_required/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
      expected: { currentStep: ConversationStep.CONFIRMING_DATA },
      actor: 'dev',
      reason: ' '
    }),
    /candidate_admin_interview_reason_required/
  );
  await assert.rejects(
    () => reflectCandidateAdminInterviewProgress(client, {
      candidateId: candidate.id,
      action: CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
      expected: { currentStep: ConversationStep.CONFIRMING_DATA },
      actor: 'dev',
      reason: 'test',
      nextStep: ConversationStep.DONE
    }),
    /candidate_admin_interview_next_step_not_allowed/
  );
});
