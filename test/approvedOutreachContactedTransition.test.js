import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markApprovedOutreachPreparedAsContacted } from '../src/routes/admin.js';

function createPrismaHarness(updateCount) {
  const calls = {
    transactions: 0,
    updates: [],
    audits: []
  };

  const tx = {
    candidate: {
      async updateMany(args) {
        calls.updates.push(args);
        return { count: updateCount };
      }
    },
    candidateAdminEvent: {
      async createMany(args) {
        calls.audits.push(args);
        return { count: args.data.length };
      }
    }
  };

  return {
    calls,
    prisma: {
      async $transaction(callback) {
        calls.transactions += 1;
        return callback(tx);
      }
    }
  };
}

const selectedCandidates = [
  { id: 'candidate-approved-1' },
  { id: 'candidate-approved-2' }
];

test('preparar aprobados cambia únicamente APROBADO a CONTACTADO y audita cada candidato', async () => {
  const { prisma, calls } = createPrismaHarness(2);

  const result = await markApprovedOutreachPreparedAsContacted(prisma, selectedCandidates, 'admin');

  assert.deepEqual(result, { count: 2 });
  assert.equal(calls.transactions, 1);
  assert.deepEqual(calls.updates, [{
    where: {
      id: { in: ['candidate-approved-1', 'candidate-approved-2'] },
      status: 'APROBADO'
    },
    data: { status: 'CONTACTADO' }
  }]);
  assert.equal(calls.audits.length, 1);
  assert.deepEqual(calls.audits[0].data, [
    {
      candidateId: 'candidate-approved-1',
      actorRole: 'admin',
      eventType: 'STATUS_CHANGED',
      eventLabel: 'Incluido en mensajes a aprobados',
      fromValue: 'Aprobado',
      toValue: 'Contactado'
    },
    {
      candidateId: 'candidate-approved-2',
      actorRole: 'admin',
      eventType: 'STATUS_CHANGED',
      eventLabel: 'Incluido en mensajes a aprobados',
      fromValue: 'Aprobado',
      toValue: 'Contactado'
    }
  ]);
});

test('una selección concurrentemente inválida aborta la ronda antes de auditar', async () => {
  const { prisma, calls } = createPrismaHarness(1);

  await assert.rejects(
    () => markApprovedOutreachPreparedAsContacted(prisma, selectedCandidates, 'dev'),
    /approved_outreach_status_conflict/
  );

  assert.equal(calls.transactions, 1);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.audits.length, 0);
});

test('una selección vacía no abre transacción ni escribe estado', async () => {
  const { prisma, calls } = createPrismaHarness(0);

  const result = await markApprovedOutreachPreparedAsContacted(prisma, [], 'admin');

  assert.deepEqual(result, { count: 0 });
  assert.equal(calls.transactions, 0);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.audits.length, 0);
});

test('la transición queda conectada solo al POST que prepara la ronda', () => {
  const source = readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
  const getStart = source.indexOf("router.get('/outreach/approved'");
  const postStart = source.indexOf("router.post('/outreach/approved/prepare'");
  const nextRoute = source.indexOf("router.get('/bot-knowledge'", postStart);

  assert.ok(getStart >= 0 && postStart > getStart && nextRoute > postStart);
  const getRoute = source.slice(getStart, postStart);
  const postRoute = source.slice(postStart, nextRoute);

  assert.doesNotMatch(getRoute, /markApprovedOutreachPreparedAsContacted/);
  assert.match(postRoute, /selectedCandidates/);
  assert.match(postRoute, /selectedCandidates\.length !== selectedIds\.size/);
  assert.match(postRoute, /markApprovedOutreachPreparedAsContacted\(prisma, selectedCandidates, req\.userRole\)/);
  assert.match(postRoute, /Los seleccionados pasaron a Contactados/);
});
