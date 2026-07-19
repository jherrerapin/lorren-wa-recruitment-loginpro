import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireCandidateMultilineBatch,
  scheduleCandidateMultilineWindow
} from '../src/services/candidateStateService.js';

function createHarness(initialCandidate) {
  let state = initialCandidate ? { ...initialCandidate } : null;
  const calls = { update: [], updateMany: [], transactions: 0 };

  const client = {
    candidate: {
      update: async (args) => {
        calls.update.push(args);
        if (!state || state.id !== args.where.id) throw new Error('candidate_not_found');
        state = {
          ...state,
          multilineWindowUntil: args.data.multilineWindowUntil,
          multilineBatchVersion: state.multilineBatchVersion + args.data.multilineBatchVersion.increment
        };
        return { multilineBatchVersion: state.multilineBatchVersion };
      },
      updateMany: async (args) => {
        calls.updateMany.push(args);
        const deadline = state?.multilineWindowUntil ? new Date(state.multilineWindowUntil).getTime() : null;
        const limit = args.where.multilineWindowUntil?.lte
          ? new Date(args.where.multilineWindowUntil.lte).getTime()
          : null;
        const matches = Boolean(
          state
          && state.id === args.where.id
          && state.multilineBatchVersion === args.where.multilineBatchVersion
          && deadline !== null
          && limit !== null
          && deadline <= limit
        );
        if (!matches) return { count: 0 };
        state = {
          ...state,
          multilineWindowUntil: null,
          multilineBatchVersion: state.multilineBatchVersion + args.data.multilineBatchVersion.increment
        };
        return { count: 1 };
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
  id: 'candidate-multiline-1',
  multilineWindowUntil: null,
  multilineBatchVersion: 4
};

const windowUntil = new Date('2026-07-19T13:00:05.000Z');
const acquireAt = new Date('2026-07-19T13:00:05.001Z');

test('programa la ventana exacta e incrementa una sola versión', async () => {
  const { client, calls, getState } = createHarness(candidate);

  const result = await scheduleCandidateMultilineWindow(client, {
    candidateId: candidate.id,
    windowUntil
  });

  assert.equal(result.batchVersion, 5);
  assert.equal(result.windowUntil.getTime(), windowUntil.getTime());
  assert.equal(getState().multilineWindowUntil.getTime(), windowUntil.getTime());
  assert.equal(getState().multilineBatchVersion, 5);
  assert.deepEqual(calls.update[0], {
    where: { id: candidate.id },
    data: {
      multilineWindowUntil: windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });
  assert.equal(calls.transactions, 0);
});

test('adquiere únicamente la versión exacta después del vencimiento', async () => {
  const { client, calls, getState } = createHarness({
    ...candidate,
    multilineWindowUntil: windowUntil,
    multilineBatchVersion: 5
  });

  const result = await acquireCandidateMultilineBatch(client, {
    candidateId: candidate.id,
    expectedBatchVersion: 5,
    now: acquireAt
  });

  assert.equal(result.count, 1);
  assert.equal(getState().multilineWindowUntil, null);
  assert.equal(getState().multilineBatchVersion, 6);
  assert.deepEqual(calls.updateMany[0].where, {
    id: candidate.id,
    multilineBatchVersion: 5,
    multilineWindowUntil: { lte: acquireAt }
  });
  assert.deepEqual(calls.updateMany[0].data, {
    multilineWindowUntil: null,
    multilineBatchVersion: { increment: 1 }
  });
  assert.equal(calls.transactions, 0);
});

test('una versión obsoleta o una ventana abierta devuelven count cero sin mutar', async () => {
  const stale = createHarness({
    ...candidate,
    multilineWindowUntil: windowUntil,
    multilineBatchVersion: 6
  });
  const staleResult = await acquireCandidateMultilineBatch(stale.client, {
    candidateId: candidate.id,
    expectedBatchVersion: 5,
    now: acquireAt
  });
  assert.equal(staleResult.count, 0);
  assert.equal(stale.getState().multilineBatchVersion, 6);
  assert.equal(stale.getState().multilineWindowUntil.getTime(), windowUntil.getTime());

  const early = createHarness({
    ...candidate,
    multilineWindowUntil: windowUntil,
    multilineBatchVersion: 5
  });
  const earlyResult = await acquireCandidateMultilineBatch(early.client, {
    candidateId: candidate.id,
    expectedBatchVersion: 5,
    now: new Date('2026-07-19T13:00:04.999Z')
  });
  assert.equal(earlyResult.count, 0);
  assert.equal(early.getState().multilineBatchVersion, 5);
  assert.equal(early.getState().multilineWindowUntil.getTime(), windowUntil.getTime());
});

test('rechaza clientes, IDs, versiones y fechas inválidas', async () => {
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(null, {}),
    /candidate_multiline_state_client_required/
  );

  const { client } = createHarness(candidate);
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: ' ', windowUntil }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: candidate.id, windowUntil: null }),
    /candidate_multiline_window_until_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: candidate.id, windowUntil: false }),
    /candidate_multiline_window_until_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: candidate.id, windowUntil: 'not-a-date' }),
    /candidate_multiline_window_until_invalid/
  );

  for (const expectedBatchVersion of [null, -1, 1.5, '5']) {
    await assert.rejects(
      () => acquireCandidateMultilineBatch(client, {
        candidateId: candidate.id,
        expectedBatchVersion,
        now: acquireAt
      }),
      /candidate_multiline_batch_version_invalid/
    );
  }

  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: candidate.id,
      expectedBatchVersion: 5,
      now: null
    }),
    /candidate_multiline_acquire_now_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: candidate.id,
      expectedBatchVersion: 5,
      now: false
    }),
    /candidate_multiline_acquire_now_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: candidate.id,
      expectedBatchVersion: 5,
      now: 'not-a-date'
    }),
    /candidate_multiline_acquire_now_invalid/
  );
});
