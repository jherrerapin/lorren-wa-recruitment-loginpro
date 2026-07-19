import test from 'node:test';
import assert from 'node:assert/strict';
import { CandidateStatus, ConversationStep, ReminderState } from '@prisma/client';
import { completeCandidateRequirementRejection } from '../src/services/candidateStateService.js';

function matchesDateFilter(actual, expected) {
  if (expected === null) return actual === null;
  const actualDate = actual instanceof Date ? actual : new Date(actual);
  return actualDate >= expected.gte && actualDate < expected.lt;
}

function createClient(initialState) {
  let state = { ...initialState };
  const calls = { updateMany: [], findUnique: [], transaction: 0 };

  return {
    calls,
    getState: () => ({ ...state }),
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        const where = args.where || {};
        const matches = state.id === where.id
          && state.currentStep === where.currentStep
          && state.status === where.status
          && state.rejectionReason === where.rejectionReason
          && state.rejectionDetails === where.rejectionDetails
          && state.reminderState === where.reminderState
          && matchesDateFilter(state.reminderScheduledFor, where.reminderScheduledFor);
        if (!matches) return { count: 0 };
        state = { ...state, ...args.data };
        return { count: 1 };
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return state.id === args.where.id ? { ...state } : null;
      }
    },
    $transaction: async () => {
      calls.transaction += 1;
      throw new Error('nested_transaction_not_allowed');
    }
  };
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-rejection-1',
    currentStep: ConversationStep.ASK_CV,
    status: CandidateStatus.REGISTRADO,
    rejectionReason: null,
    rejectionDetails: null,
    reminderScheduledFor: new Date('2026-07-21T14:00:00.000Z'),
    reminderState: ReminderState.SCHEDULED,
    ...overrides
  };
}

function transitionInput(snapshot, overrides = {}) {
  return {
    candidateId: snapshot.id,
    expected: {
      currentStep: snapshot.currentStep,
      status: snapshot.status,
      rejectionReason: snapshot.rejectionReason,
      rejectionDetails: snapshot.rejectionDetails,
      reminderScheduledFor: snapshot.reminderScheduledFor,
      reminderState: snapshot.reminderState
    },
    reason: 'La edad registrada no cumple el mínimo de la vacante',
    details: 'age_below_min: Edad detectada: 17. Rango requerido: mínimo 18 años.',
    ...overrides
  };
}

test('rechaza por requisito con snapshot exacto y solo seis campos permitidos', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);
  const input = transitionInput(snapshot);

  const result = await completeCandidateRequirementRejection(client, input);

  assert.equal(result.count, 1);
  assert.equal(result.candidate.currentStep, ConversationStep.DONE);
  assert.equal(result.candidate.status, CandidateStatus.RECHAZADO);
  assert.equal(result.candidate.rejectionReason, input.reason);
  assert.equal(result.candidate.rejectionDetails, input.details);
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, ReminderState.SKIPPED);
  assert.deepEqual(client.calls.updateMany[0].data, {
    currentStep: ConversationStep.DONE,
    status: CandidateStatus.RECHAZADO,
    rejectionReason: input.reason,
    rejectionDetails: input.details,
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED
  });
  assert.deepEqual(client.calls.updateMany[0].where, {
    id: snapshot.id,
    currentStep: snapshot.currentStep,
    status: snapshot.status,
    rejectionReason: null,
    rejectionDetails: null,
    reminderScheduledFor: {
      gte: snapshot.reminderScheduledFor,
      lt: new Date(snapshot.reminderScheduledFor.getTime() + 1)
    },
    reminderState: snapshot.reminderState
  });
});

test('una carrera por currentStep conserva el estado vigente', async () => {
  const expected = candidate();
  const client = createClient(candidate({ currentStep: ConversationStep.CONFIRMING_DATA }));

  const result = await completeCandidateRequirementRejection(client, transitionInput(expected));

  assert.equal(result.count, 0);
  assert.equal(result.candidate.currentStep, ConversationStep.CONFIRMING_DATA);
  assert.equal(result.candidate.status, CandidateStatus.REGISTRADO);
});

test('una carrera por status conserva la selección vigente', async () => {
  const expected = candidate();
  const client = createClient(candidate({ status: CandidateStatus.CONTACTADO }));

  const result = await completeCandidateRequirementRejection(client, transitionInput(expected));

  assert.equal(result.count, 0);
  assert.equal(result.candidate.status, CandidateStatus.CONTACTADO);
  assert.equal(result.candidate.currentStep, ConversationStep.ASK_CV);
});

test('una carrera por razón o detalle conserva la trazabilidad vigente', async () => {
  const expected = candidate();
  const client = createClient(candidate({
    rejectionReason: 'Revisión humana previa',
    rejectionDetails: 'Evidencia nueva pendiente'
  }));

  const result = await completeCandidateRequirementRejection(client, transitionInput(expected));

  assert.equal(result.count, 0);
  assert.equal(result.candidate.rejectionReason, 'Revisión humana previa');
  assert.equal(result.candidate.rejectionDetails, 'Evidencia nueva pendiente');
});

test('una carrera por reminderState conserva el recordatorio vigente', async () => {
  const expected = candidate();
  const client = createClient(candidate({ reminderState: ReminderState.SENT }));

  const result = await completeCandidateRequirementRejection(client, transitionInput(expected));

  assert.equal(result.count, 0);
  assert.equal(result.candidate.reminderState, ReminderState.SENT);
  assert.equal(result.candidate.status, CandidateStatus.REGISTRADO);
});

test('una carrera por reminderScheduledFor conserva la fecha vigente', async () => {
  const expected = candidate();
  const newerDate = new Date('2026-07-22T14:00:00.000Z');
  const client = createClient(candidate({ reminderScheduledFor: newerDate }));

  const result = await completeCandidateRequirementRejection(client, transitionInput(expected));

  assert.equal(result.count, 0);
  assert.equal(result.candidate.reminderScheduledFor.getTime(), newerDate.getTime());
});

test('acepta snapshot con recordatorio nulo y permite rechazo desde DONE si aún no estaba rechazado', async () => {
  const snapshot = candidate({
    currentStep: ConversationStep.DONE,
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE
  });
  const client = createClient(snapshot);

  const result = await completeCandidateRequirementRejection(client, transitionInput(snapshot));

  assert.equal(result.count, 1);
  assert.equal(result.candidate.status, CandidateStatus.RECHAZADO);
  assert.equal(client.calls.updateMany[0].where.reminderScheduledFor, null);
});

test('un candidato ya rechazado produce no-op sin escritura', async () => {
  const snapshot = candidate({ status: CandidateStatus.RECHAZADO });
  const client = createClient(snapshot);

  const result = await completeCandidateRequirementRejection(client, transitionInput(snapshot));

  assert.equal(result.count, 0);
  assert.equal(result.blockedReason, 'already_rejected');
  assert.equal(client.calls.updateMany.length, 0);
});

test('rechaza clientes, snapshots, decisiones y enums inválidos antes de escribir', async () => {
  const snapshot = candidate();
  const valid = transitionInput(snapshot);
  const cases = [
    [{}, valid, /candidate_state_client_required/],
    [createClient(snapshot), { ...valid, candidateId: '' }, /candidate_id_required/],
    [createClient(snapshot), { ...valid, expected: null }, /candidate_requirement_rejection_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: [] }, /candidate_requirement_rejection_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: 'invalid' }, /candidate_requirement_rejection_snapshot_required/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, status: 'INVALID' } }, /candidate_requirement_rejection_status_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, currentStep: 'INVALID' } }, /candidate_requirement_rejection_current_step_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, rejectionReason: {} } }, /candidate_requirement_rejection_expected_reason_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, rejectionDetails: [] } }, /candidate_requirement_rejection_expected_details_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderState: 'INVALID' } }, /candidate_requirement_rejection_reminder_state_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderScheduledFor: true } }, /candidate_requirement_rejection_reminder_scheduled_for_invalid/],
    [createClient(snapshot), { ...valid, expected: { ...valid.expected, reminderScheduledFor: 'not-a-date' } }, /candidate_requirement_rejection_reminder_scheduled_for_invalid/],
    [createClient(snapshot), { ...valid, reason: '' }, /candidate_requirement_rejection_reason_required/],
    [createClient(snapshot), { ...valid, reason: [] }, /candidate_requirement_rejection_reason_required/],
    [createClient(snapshot), { ...valid, details: '   ' }, /candidate_requirement_rejection_details_required/],
    [createClient(snapshot), { ...valid, details: {} }, /candidate_requirement_rejection_details_required/]
  ];

  for (const [client, input, pattern] of cases) {
    await assert.rejects(() => completeCandidateRequirementRejection(client, input), pattern);
    assert.equal(client.calls?.updateMany?.length || 0, 0);
  }
});

test('reutiliza el cliente recibido sin abrir una transacción anidada', async () => {
  const snapshot = candidate();
  const client = createClient(snapshot);

  await completeCandidateRequirementRejection(client, transitionInput(snapshot));

  assert.equal(client.calls.transaction, 0);
});
