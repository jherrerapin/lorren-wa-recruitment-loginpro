import test from 'node:test';
import assert from 'node:assert/strict';
import { recordManualWhatsAppOpen } from '../src/services/candidateStateService.js';

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

const openedAt = new Date('2026-07-15T20:00:00.000Z');
const previousSeenAt = new Date('2026-07-15T19:30:00.000Z');
const baseCandidate = {
  id: 'candidate-whatsapp-open-1',
  status: 'REGISTRADO',
  botPaused: false,
  botPausedAt: null,
  botPausedBy: null,
  botPauseReason: null,
  botResumeMode: 'resumed_by_candidate_inbound',
  lastOutboundAt: null,
  reminderScheduledFor: new Date('2026-07-15T22:00:00.000Z'),
  reminderState: 'SCHEDULED',
  devLastSeenAt: previousSeenAt
};

const pauseSnapshot = {
  botPaused: false,
  botPausedAt: null,
  botPausedBy: null,
  botPauseReason: null,
  botResumeMode: 'resumed_by_candidate_inbound'
};

test('DEV abre WhatsApp sin alterar status y actualiza su marca de revisión', async () => {
  const { client, calls, getState } = createHarness(baseCandidate);

  const result = await recordManualWhatsAppOpen(client, {
    candidateId: baseCandidate.id,
    role: 'dev',
    actor: 'devloginpro',
    expected: {
      ...pauseSnapshot,
      devLastSeenAt: previousSeenAt
    },
    now: openedAt
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.status, 'REGISTRADO');
  assert.equal(result.candidate.botPaused, true);
  assert.equal(result.candidate.botPausedAt.getTime(), openedAt.getTime());
  assert.equal(result.candidate.botPausedBy, 'devloginpro');
  assert.equal(result.candidate.botResumeMode, 'manual_resume_dashboard');
  assert.equal(result.candidate.lastOutboundAt.getTime(), openedAt.getTime());
  assert.equal(result.candidate.devLastSeenAt.getTime(), openedAt.getTime());
  assert.equal(result.candidate.reminderScheduledFor, null);
  assert.equal(result.candidate.reminderState, 'CANCELLED');
  assert.deepEqual(calls.updateMany[0].where, {
    id: baseCandidate.id,
    ...pauseSnapshot,
    devLastSeenAt: previousSeenAt
  });
  assert.equal(Object.hasOwn(calls.updateMany[0].data, 'status'), false);
  assert.equal(calls.transactions, 0);
  assert.equal(getState().status, 'REGISTRADO');
});

test('ADMIN abre WhatsApp y cambia a CONTACTADO sin tocar devLastSeenAt', async () => {
  const { client, calls } = createHarness(baseCandidate);

  const result = await recordManualWhatsAppOpen(client, {
    candidateId: baseCandidate.id,
    role: 'admin',
    actor: 'reclutador-zona-norte',
    expected: {
      ...pauseSnapshot,
      status: 'REGISTRADO'
    },
    now: openedAt
  });

  assert.equal(result.count, 1);
  assert.equal(result.candidate.status, 'CONTACTADO');
  assert.equal(result.candidate.devLastSeenAt.getTime(), previousSeenAt.getTime());
  assert.equal(result.candidate.botPaused, true);
  assert.equal(result.candidate.botPausedBy, 'reclutador-zona-norte');
  assert.deepEqual(calls.updateMany[0].where, {
    id: baseCandidate.id,
    ...pauseSnapshot,
    status: 'REGISTRADO'
  });
  assert.equal(Object.hasOwn(calls.updateMany[0].data, 'devLastSeenAt'), false);
  assert.equal(calls.updateMany[0].data.status, 'CONTACTADO');
  assert.equal(calls.transactions, 0);
});

test('no sobrescribe pausas, estados ni marcas DEV concurrentes', async () => {
  const pauseHarness = createHarness(baseCandidate);
  pauseHarness.setState({
    ...baseCandidate,
    botPaused: true,
    botPausedAt: new Date('2026-07-15T19:59:00.000Z'),
    botPausedBy: 'otro-admin',
    botPauseReason: 'Intervención concurrente',
    botResumeMode: 'manual_resume_dashboard'
  });

  const pauseResult = await recordManualWhatsAppOpen(pauseHarness.client, {
    candidateId: baseCandidate.id,
    role: 'admin',
    actor: 'reclutador',
    expected: { ...pauseSnapshot, status: 'REGISTRADO' },
    now: openedAt
  });
  assert.equal(pauseResult.count, 0);
  assert.equal(pauseResult.candidate.botPausedBy, 'otro-admin');

  const statusHarness = createHarness(baseCandidate);
  statusHarness.setState({ ...baseCandidate, status: 'CONTRATADO' });
  const statusResult = await recordManualWhatsAppOpen(statusHarness.client, {
    candidateId: baseCandidate.id,
    role: 'admin',
    actor: 'reclutador',
    expected: { ...pauseSnapshot, status: 'REGISTRADO' },
    now: openedAt
  });
  assert.equal(statusResult.count, 0);
  assert.equal(statusResult.candidate.status, 'CONTRATADO');

  const devHarness = createHarness(baseCandidate);
  const newerSeenAt = new Date('2026-07-15T20:01:00.000Z');
  devHarness.setState({ ...baseCandidate, devLastSeenAt: newerSeenAt });
  const devResult = await recordManualWhatsAppOpen(devHarness.client, {
    candidateId: baseCandidate.id,
    role: 'dev',
    actor: 'devloginpro',
    expected: { ...pauseSnapshot, devLastSeenAt: previousSeenAt },
    now: openedAt
  });
  assert.equal(devResult.count, 0);
  assert.equal(devResult.candidate.devLastSeenAt.getTime(), newerSeenAt.getTime());
  assert.equal(devHarness.calls.transactions, 0);
});

test('acepta cliente transaccional sin abrir transacción anidada', async () => {
  const { client, calls } = createHarness(baseCandidate);
  const tx = { candidate: client.candidate };

  const result = await recordManualWhatsAppOpen(tx, {
    candidateId: baseCandidate.id,
    role: 'admin',
    actor: 'reclutador',
    expected: { ...pauseSnapshot, status: 'REGISTRADO' },
    now: openedAt
  });

  assert.equal(result.count, 1);
  assert.equal(calls.transactions, 0);
});

test('rechaza entradas inválidas sin convertirlas silenciosamente', async () => {
  await assert.rejects(
    () => recordManualWhatsAppOpen(null, {}),
    /candidate_state_client_required/
  );

  const { client } = createHarness(baseCandidate);
  const validAdminInput = {
    candidateId: baseCandidate.id,
    role: 'admin',
    actor: 'reclutador',
    expected: { ...pauseSnapshot, status: 'REGISTRADO' },
    now: openedAt
  };

  await assert.rejects(
    () => recordManualWhatsAppOpen(client, { ...validAdminInput, candidateId: ' ' }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => recordManualWhatsAppOpen(client, { ...validAdminInput, role: 'supervisor' }),
    /candidate_admin_role_invalid/
  );
  await assert.rejects(
    () => recordManualWhatsAppOpen(client, { ...validAdminInput, actor: ' ' }),
    /candidate_whatsapp_open_actor_required/
  );
  await assert.rejects(
    () => recordManualWhatsAppOpen(client, { ...validAdminInput, expected: {} }),
    /candidate_expected_pause_snapshot_required/
  );
  await assert.rejects(
    () => recordManualWhatsAppOpen(client, {
      ...validAdminInput,
      expected: { ...pauseSnapshot, status: ' ' }
    }),
    /candidate_expected_status_required/
  );
  await assert.rejects(
    () => recordManualWhatsAppOpen(client, {
      ...validAdminInput,
      role: 'dev',
      expected: { ...pauseSnapshot, devLastSeenAt: false }
    }),
    /candidate_expected_dev_last_seen_at_invalid/
  );
  await assert.rejects(
    () => recordManualWhatsAppOpen(client, { ...validAdminInput, reason: ' ' }),
    /candidate_whatsapp_open_reason_required/
  );
  await assert.rejects(
    () => recordManualWhatsAppOpen(client, { ...validAdminInput, now: null }),
    /candidate_whatsapp_open_now_invalid/
  );
});
