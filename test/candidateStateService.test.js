import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeCandidateAutomationOnInbound } from '../src/services/candidateStateService.js';

function sameValue(left, right) {
  if (left instanceof Date || right instanceof Date) {
    return new Date(left).getTime() === new Date(right).getTime();
  }
  return left === right;
}

function matchesWhere(candidate, where = {}) {
  return Object.entries(where).every(([field, expected]) => sameValue(candidate?.[field], expected));
}

function createHarness(initialCandidate) {
  let state = initialCandidate ? { ...initialCandidate } : null;
  const calls = { updateMany: [], findUnique: [], transactions: 0 };

  const client = {
    candidate: {
      updateMany: async (args) => {
        calls.updateMany.push(args);
        if (!state || !matchesWhere(state, args.where)) return { count: 0 };
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

  return { client, calls, getState: () => (state ? { ...state } : null), setState: (next) => { state = next ? { ...next } : null; } };
}

const pausedAt = new Date('2026-07-15T14:00:00.000Z');
const resumeAt = new Date('2026-07-15T14:05:00.000Z');
const pausedCandidate = {
  id: 'candidate-1',
  botPaused: true,
  botPausedAt: pausedAt,
  botPausedBy: 'admin@loginpro.co',
  botPauseReason: 'Conversacion tomada manualmente desde dashboard',
  botResumeMode: 'manual_resume_dashboard',
  reminderScheduledFor: new Date('2026-07-15T16:00:00.000Z'),
  reminderState: 'SCHEDULED'
};

const expectedSnapshot = {
  botPaused: true,
  botPausedAt: pausedAt,
  botPausedBy: pausedCandidate.botPausedBy,
  botPauseReason: pausedCandidate.botPauseReason,
  botResumeMode: pausedCandidate.botResumeMode
};

test('reanuda únicamente el snapshot de pausa exacto y devuelve el candidato actualizado', async () => {
  const { client, calls, getState } = createHarness(pausedCandidate);

  const result = await resumeCandidateAutomationOnInbound(client, {
    candidateId: pausedCandidate.id,
    expected: expectedSnapshot,
    now: resumeAt
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.botPaused, false);
  assert.equal(result.candidate.botPausedAt, null);
  assert.equal(result.candidate.botPausedBy, null);
  assert.equal(result.candidate.botPauseReason, null);
  assert.equal(result.candidate.botResumeMode, 'resumed_by_candidate_inbound');
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, 'CANCELLED');
  assert.deepEqual(calls.updateMany[0].where, { id: pausedCandidate.id, ...expectedSnapshot });
  assert.equal(calls.transactions, 0);
  assert.equal(getState().botPaused, false);
});

test('una pausa concurrente no se sobrescribe ni se informa como reanudada', async () => {
  const { client, calls, setState, getState } = createHarness(pausedCandidate);
  setState({
    ...pausedCandidate,
    botPausedAt: new Date('2026-07-15T14:03:00.000Z'),
    botPauseReason: 'Nueva intervención humana',
    botResumeMode: 'awaiting_inbound_after_human_intervention'
  });

  const result = await resumeCandidateAutomationOnInbound(client, {
    candidateId: pausedCandidate.id,
    expected: expectedSnapshot,
    now: resumeAt
  });

  assert.equal(result.count, 0);
  assert.equal(result.candidate.botPaused, true);
  assert.equal(result.candidate.botPauseReason, 'Nueva intervención humana');
  assert.equal(getState().botResumeMode, 'awaiting_inbound_after_human_intervention');
  assert.equal(calls.updateMany.length, 1);
  assert.equal(calls.findUnique.length, 1);
  assert.equal(calls.transactions, 0);
});

test('reutiliza el cliente recibido sin abrir una transacción anidada', async () => {
  const { client, calls } = createHarness(pausedCandidate);

  await resumeCandidateAutomationOnInbound(client, {
    candidateId: pausedCandidate.id,
    expected: expectedSnapshot,
    now: resumeAt
  });

  assert.equal(calls.transactions, 0);
  assert.equal(calls.updateMany.length, 1);
});

test('rechaza cliente, candidato, fecha y snapshot de pausa inválidos', async () => {
  await assert.rejects(
    () => resumeCandidateAutomationOnInbound(null, {}),
    /candidate_state_client_required/
  );

  const { client } = createHarness(pausedCandidate);
  await assert.rejects(
    () => resumeCandidateAutomationOnInbound(client, { candidateId: '   ', expected: expectedSnapshot }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => resumeCandidateAutomationOnInbound(client, { candidateId: pausedCandidate.id, expected: { botPaused: false } }),
    /candidate_expected_paused_state_required/
  );
  await assert.rejects(
    () => resumeCandidateAutomationOnInbound(client, { candidateId: pausedCandidate.id, expected: expectedSnapshot, now: 'no-date' }),
    /candidate_resume_now_invalid/
  );
  await assert.rejects(
    () => resumeCandidateAutomationOnInbound(client, { candidateId: pausedCandidate.id, expected: expectedSnapshot, now: null }),
    /candidate_resume_now_invalid/
  );
  await assert.rejects(
    () => resumeCandidateAutomationOnInbound(client, { candidateId: pausedCandidate.id, expected: expectedSnapshot, now: false }),
    /candidate_resume_now_invalid/
  );
  await assert.rejects(
    () => resumeCandidateAutomationOnInbound(client, {
      candidateId: pausedCandidate.id,
      expected: { ...expectedSnapshot, botPausedAt: 'no-date' }
    }),
    /candidate_expected_bot_paused_at_invalid/
  );
  await assert.rejects(
    () => resumeCandidateAutomationOnInbound(client, {
      candidateId: pausedCandidate.id,
      expected: { ...expectedSnapshot, botPausedAt: false }
    }),
    /candidate_expected_bot_paused_at_invalid/
  );
});
