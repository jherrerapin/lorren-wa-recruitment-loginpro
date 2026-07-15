import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pauseCandidateAutomationFromAdmin,
  resumeCandidateAutomationFromAdmin
} from '../src/services/candidateStateService.js';

function sameValue(left, right) {
  if (left instanceof Date || right instanceof Date) {
    if (left == null || right == null) return left === right;
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

  return {
    client,
    calls,
    getState: () => (state ? { ...state } : null),
    setState: (next) => { state = next ? { ...next } : null; }
  };
}

const pauseAt = new Date('2026-07-15T16:00:00.000Z');
const unpausedCandidate = {
  id: 'candidate-admin-1',
  botPaused: false,
  botPausedAt: null,
  botPausedBy: null,
  botPauseReason: null,
  botResumeMode: 'resumed_by_candidate_inbound',
  reminderScheduledFor: new Date('2026-07-15T18:00:00.000Z'),
  reminderState: 'SCHEDULED'
};

const unpausedSnapshot = {
  botPaused: false,
  botPausedAt: null,
  botPausedBy: null,
  botPauseReason: null,
  botResumeMode: 'resumed_by_candidate_inbound'
};

const pausedCandidate = {
  ...unpausedCandidate,
  botPaused: true,
  botPausedAt: pauseAt,
  botPausedBy: 'dev',
  botPauseReason: 'Pausa manual desde admin',
  botResumeMode: 'manual_resume_dashboard',
  reminderScheduledFor: null,
  reminderState: 'CANCELLED'
};

const pausedSnapshot = {
  botPaused: true,
  botPausedAt: pauseAt,
  botPausedBy: 'dev',
  botPauseReason: 'Pausa manual desde admin',
  botResumeMode: 'manual_resume_dashboard'
};

test('pausa desde admin únicamente el snapshot exacto y cancela recordatorios', async () => {
  const { client, calls, getState } = createHarness(unpausedCandidate);

  const result = await pauseCandidateAutomationFromAdmin(client, {
    candidateId: unpausedCandidate.id,
    expected: unpausedSnapshot,
    actor: 'dev',
    reason: 'Revisión manual de conversación',
    now: pauseAt
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.botPaused, true);
  assert.equal(result.candidate.botPausedAt.getTime(), pauseAt.getTime());
  assert.equal(result.candidate.botPausedBy, 'dev');
  assert.equal(result.candidate.botPauseReason, 'Revisión manual de conversación');
  assert.equal(result.candidate.botResumeMode, 'manual_resume_dashboard');
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, 'CANCELLED');
  assert.deepEqual(calls.updateMany[0].where, { id: unpausedCandidate.id, ...unpausedSnapshot });
  assert.equal(calls.transactions, 0);
  assert.equal(getState().botPaused, true);
});

test('reanuda desde admin únicamente la pausa exacta y limpia toda la metadata', async () => {
  const { client, calls, getState } = createHarness(pausedCandidate);

  const result = await resumeCandidateAutomationFromAdmin(client, {
    candidateId: pausedCandidate.id,
    expected: pausedSnapshot
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.botPaused, false);
  assert.equal(result.candidate.botPausedAt, null);
  assert.equal(result.candidate.botPausedBy, null);
  assert.equal(result.candidate.botPauseReason, null);
  assert.equal(result.candidate.botResumeMode, 'manual_resume_dashboard');
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, 'CANCELLED');
  assert.deepEqual(calls.updateMany[0].where, { id: pausedCandidate.id, ...pausedSnapshot });
  assert.equal(calls.transactions, 0);
  assert.equal(getState().botPaused, false);
});

test('una pausa concurrente no es sobrescrita ni levantada', async () => {
  const pauseHarness = createHarness(unpausedCandidate);
  pauseHarness.setState({
    ...unpausedCandidate,
    botPaused: true,
    botPausedAt: new Date('2026-07-15T15:59:00.000Z'),
    botPausedBy: 'otro-admin',
    botPauseReason: 'Intervención concurrente',
    botResumeMode: 'awaiting_inbound_after_human_intervention'
  });

  const pauseResult = await pauseCandidateAutomationFromAdmin(pauseHarness.client, {
    candidateId: unpausedCandidate.id,
    expected: unpausedSnapshot,
    actor: 'dev',
    reason: 'Revisión manual de conversación',
    now: pauseAt
  });

  assert.equal(pauseResult.count, 0);
  assert.equal(pauseResult.candidate.botPausedBy, 'otro-admin');
  assert.equal(pauseResult.candidate.botPauseReason, 'Intervención concurrente');

  const resumeHarness = createHarness(pausedCandidate);
  resumeHarness.setState({
    ...pausedCandidate,
    botPausedAt: new Date('2026-07-15T16:02:00.000Z'),
    botPausedBy: 'otro-admin',
    botPauseReason: 'Nueva pausa concurrente'
  });

  const resumeResult = await resumeCandidateAutomationFromAdmin(resumeHarness.client, {
    candidateId: pausedCandidate.id,
    expected: pausedSnapshot
  });

  assert.equal(resumeResult.count, 0);
  assert.equal(resumeResult.candidate.botPaused, true);
  assert.equal(resumeResult.candidate.botPauseReason, 'Nueva pausa concurrente');
  assert.equal(resumeHarness.calls.transactions, 0);
});

test('rechaza entradas administrativas inválidas', async () => {
  await assert.rejects(
    () => pauseCandidateAutomationFromAdmin(null, {}),
    /candidate_state_client_required/
  );

  const { client } = createHarness(unpausedCandidate);
  await assert.rejects(
    () => pauseCandidateAutomationFromAdmin(client, {
      candidateId: ' ', expected: unpausedSnapshot, actor: 'dev', reason: 'motivo'
    }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => pauseCandidateAutomationFromAdmin(client, {
      candidateId: unpausedCandidate.id, expected: {}, actor: 'dev', reason: 'motivo'
    }),
    /candidate_expected_pause_snapshot_required/
  );
  await assert.rejects(
    () => pauseCandidateAutomationFromAdmin(client, {
      candidateId: unpausedCandidate.id, expected: unpausedSnapshot, actor: ' ', reason: 'motivo'
    }),
    /candidate_pause_actor_required/
  );
  await assert.rejects(
    () => pauseCandidateAutomationFromAdmin(client, {
      candidateId: unpausedCandidate.id, expected: unpausedSnapshot, actor: 'dev', reason: ' '
    }),
    /candidate_pause_reason_required/
  );
  await assert.rejects(
    () => pauseCandidateAutomationFromAdmin(client, {
      candidateId: unpausedCandidate.id,
      expected: unpausedSnapshot,
      actor: 'dev',
      reason: 'motivo',
      now: null
    }),
    /candidate_pause_now_invalid/
  );
  await assert.rejects(
    () => pauseCandidateAutomationFromAdmin(client, {
      candidateId: unpausedCandidate.id,
      expected: { ...unpausedSnapshot, botPausedAt: false },
      actor: 'dev',
      reason: 'motivo'
    }),
    /candidate_expected_bot_paused_at_invalid/
  );
  await assert.rejects(
    () => resumeCandidateAutomationFromAdmin(client, {
      candidateId: unpausedCandidate.id,
      expected: unpausedSnapshot
    }),
    /candidate_expected_paused_state_required/
  );
});
