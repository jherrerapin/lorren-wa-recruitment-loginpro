import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireCandidateMultilineBatch,
  scheduleCandidateMultilineWindow
} from '../src/services/candidateStateService.js';

function sameScalar(left, right) {
  if (left instanceof Date || right instanceof Date) {
    if (left == null || right == null) return left === right;
    return new Date(left).getTime() === new Date(right).getTime();
  }
  return left === right;
}

function matchesExpected(actual, expected) {
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    if ('lte' in expected && !(new Date(actual).getTime() <= new Date(expected.lte).getTime())) return false;
    if ('lt' in expected && !(new Date(actual).getTime() < new Date(expected.lt).getTime())) return false;
    if ('gte' in expected && !(new Date(actual).getTime() >= new Date(expected.gte).getTime())) return false;
    if ('gt' in expected && !(new Date(actual).getTime() > new Date(expected.gt).getTime())) return false;
    return true;
  }
  return sameScalar(actual, expected);
}

function matchesWhere(candidate, where = {}) {
  return Object.entries(where).every(([field, expected]) => matchesExpected(candidate?.[field], expected));
}

function applyData(candidate, data = {}) {
  const next = { ...candidate };
  for (const [field, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'increment' in value) {
      next[field] = Number(next[field] || 0) + Number(value.increment || 0);
      continue;
    }
    next[field] = value;
  }
  return next;
}

function createHarness(initialCandidate) {
  let state = initialCandidate ? { ...initialCandidate } : null;
  const calls = { update: [], updateMany: [], transactions: 0 };

  const client = {
    candidate: {
      update: async (args) => {
        calls.update.push(args);
        if (!state || state.id !== args.where.id) throw new Error('candidate_not_found');
        state = applyData(state, args.data);
        if (args.select) {
          return Object.fromEntries(
            Object.entries(args.select)
              .filter(([, selected]) => selected)
              .map(([field]) => [field, state[field]])
          );
        }
        return { ...state };
      },
      updateMany: async (args) => {
        calls.updateMany.push(args);
        if (!state || !matchesWhere(state, args.where)) return { count: 0 };
        state = applyData(state, args.data);
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

const initialCandidate = {
  id: 'candidate-multiline-1',
  multilineWindowUntil: null,
  multilineBatchVersion: 4
};

const scheduleNow = new Date('2026-07-18T15:00:00.000Z');

test('programa la ventana, incrementa la versión y devuelve el snapshot adquirido', async () => {
  const { client, calls, getState } = createHarness(initialCandidate);

  const result = await scheduleCandidateMultilineWindow(client, {
    candidateId: initialCandidate.id,
    windowMs: 2500,
    now: scheduleNow
  });

  assert.equal(result.windowMs, 2500);
  assert.equal(result.batchVersion, 5);
  assert.equal(result.windowUntil.toISOString(), '2026-07-18T15:00:02.500Z');
  assert.equal(getState().multilineBatchVersion, 5);
  assert.equal(getState().multilineWindowUntil.toISOString(), result.windowUntil.toISOString());
  assert.deepEqual(calls.update[0], {
    where: { id: initialCandidate.id },
    data: {
      multilineWindowUntil: result.windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });
  assert.equal(calls.transactions, 0);
});

test('cada nueva programación invalida la versión anterior', async () => {
  const { client } = createHarness(initialCandidate);

  const first = await scheduleCandidateMultilineWindow(client, {
    candidateId: initialCandidate.id,
    windowMs: 1000,
    now: scheduleNow
  });
  const second = await scheduleCandidateMultilineWindow(client, {
    candidateId: initialCandidate.id,
    windowMs: 1500,
    now: new Date('2026-07-18T15:00:00.250Z')
  });

  assert.equal(first.batchVersion, 5);
  assert.equal(second.batchVersion, 6);
  assert.equal(second.windowUntil.toISOString(), '2026-07-18T15:00:01.750Z');
});

test('adquiere una sola vez la versión vencida mediante updateMany condicional', async () => {
  const windowUntil = new Date('2026-07-18T15:00:02.500Z');
  const { client, calls, getState } = createHarness({
    ...initialCandidate,
    multilineWindowUntil: windowUntil,
    multilineBatchVersion: 5
  });

  const acquired = await acquireCandidateMultilineBatch(client, {
    candidateId: initialCandidate.id,
    expected: { multilineBatchVersion: 5 },
    now: windowUntil
  });

  assert.equal(acquired.count, 1);
  assert.equal(getState().multilineWindowUntil, null);
  assert.equal(getState().multilineBatchVersion, 6);
  assert.deepEqual(calls.updateMany[0], {
    where: {
      id: initialCandidate.id,
      multilineBatchVersion: 5,
      multilineWindowUntil: { lte: windowUntil }
    },
    data: {
      multilineWindowUntil: null,
      multilineBatchVersion: { increment: 1 }
    }
  });
  assert.equal(calls.transactions, 0);

  const repeated = await acquireCandidateMultilineBatch(client, {
    candidateId: initialCandidate.id,
    expected: { multilineBatchVersion: 5 },
    now: new Date('2026-07-18T15:00:03.000Z')
  });
  assert.equal(repeated.count, 0);
  assert.equal(getState().multilineBatchVersion, 6);
});

test('una versión obsoleta o una ventana no vencida no se informa como adquirida', async () => {
  const windowUntil = new Date('2026-07-18T15:00:05.000Z');
  const { client, getState } = createHarness({
    ...initialCandidate,
    multilineWindowUntil: windowUntil,
    multilineBatchVersion: 8
  });

  const stale = await acquireCandidateMultilineBatch(client, {
    candidateId: initialCandidate.id,
    expected: { multilineBatchVersion: 7 },
    now: new Date('2026-07-18T15:00:06.000Z')
  });
  assert.equal(stale.count, 0);

  const early = await acquireCandidateMultilineBatch(client, {
    candidateId: initialCandidate.id,
    expected: { multilineBatchVersion: 8 },
    now: new Date('2026-07-18T15:00:04.999Z')
  });
  assert.equal(early.count, 0);
  assert.equal(getState().multilineWindowUntil.toISOString(), windowUntil.toISOString());
  assert.equal(getState().multilineBatchVersion, 8);
});

test('rechaza clientes, ids, duraciones, versiones y fechas inválidas', async () => {
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(null, {}),
    /candidate_multiline_schedule_client_required/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(null, {}),
    /candidate_multiline_acquire_client_required/
  );

  const { client } = createHarness(initialCandidate);
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: ' ', windowMs: 1000 }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: initialCandidate.id, windowMs: -1 }),
    /candidate_multiline_window_ms_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: initialCandidate.id, windowMs: Number.NaN }),
    /candidate_multiline_window_ms_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: initialCandidate.id, windowMs: [2500] }),
    /candidate_multiline_window_ms_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: initialCandidate.id, windowMs: { value: 2500 } }),
    /candidate_multiline_window_ms_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: initialCandidate.id, windowMs: 1000, now: null }),
    /candidate_multiline_schedule_now_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: -1 }
    }),
    /candidate_multiline_batch_version_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: 1.5 }
    }),
    /candidate_multiline_batch_version_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: [4] }
    }),
    /candidate_multiline_batch_version_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: { value: 4 } }
    }),
    /candidate_multiline_batch_version_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: 4 },
      now: 'not-a-date'
    }),
    /candidate_multiline_acquire_now_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: 4 },
      now: false
    }),
    /candidate_multiline_acquire_now_invalid/
  );
});
