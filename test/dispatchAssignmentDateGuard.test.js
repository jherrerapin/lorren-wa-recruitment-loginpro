import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  addDateToAssignmentRedirect,
  assignmentDateFromQuery,
  buildAssignmentDateNavigationScript,
  loadAssignmentDateContext
} from '../src/routes/dispatchAssignmentDateGuard.js';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('assignment date query uses explicit date and respects allDates', () => {
  assert.equal(assignmentDateFromQuery({ fecha: '2026-08-12' }), '2026-08-12');
  assert.equal(assignmentDateFromQuery({ date: '2026-08-13' }), '2026-08-13');
  assert.equal(assignmentDateFromQuery({ fecha: '2026-08-12', allDates: '1' }), null);
  assert.equal(assignmentDateFromQuery({ fecha: '2026-08-12', allDates: 'true' }), null);
});

test('assignment date context filters service requests in Prisma and selects a request from that date', async () => {
  const captured = { requestWhere: null, assignmentWhere: null };
  const requests = [
    {
      id: 'request-a',
      serviceDate: new Date('2026-08-12T05:00:00.000Z'),
      assignments: [{ workerId: 'worker-1', worker: { id: 'worker-1' } }]
    },
    {
      id: 'request-b',
      serviceDate: new Date('2026-08-12T05:00:00.000Z'),
      assignments: []
    }
  ];
  const prisma = {
    dispatchServiceRequest: {
      findMany: async (args) => {
        captured.requestWhere = args.where;
        return requests;
      }
    },
    dispatchAssignment: {
      findMany: async (args) => {
        captured.assignmentWhere = args.where;
        return [{ workerId: 'worker-2' }];
      }
    }
  };

  const context = await loadAssignmentDateContext(prisma, '2026-08-12', 'request-b');

  assert.equal(context.selectedDate, '2026-08-12');
  assert.equal(context.selectedServiceRequest.id, 'request-b');
  assert.deepEqual(context.serviceRequests.map((request) => request.id), ['request-a', 'request-b']);
  assert.equal(context.blockedWorkerIds.size, 0);
  assert.equal(context.assignedWorkerIdsOnSelectedDate.has('worker-2'), true);
  assert.ok(captured.requestWhere.serviceDate.gte instanceof Date);
  assert.ok(captured.requestWhere.serviceDate.lt instanceof Date);
  assert.equal(captured.requestWhere.serviceDate.gte.toISOString(), '2026-08-12T00:00:00.000Z');
  assert.equal(captured.requestWhere.serviceDate.lt.toISOString(), '2026-08-13T05:00:00.000Z');
  assert.deepEqual(captured.assignmentWhere.serviceRequestId, { not: 'request-b' });
  assert.deepEqual(captured.assignmentWhere.status, { in: ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'] });
});

test('manual assignment redirects preserve the service date without touching unrelated URLs', () => {
  assert.equal(
    addDateToAssignmentRedirect('/admin/operaciones/asignaciones?serviceRequestId=req-1&message=ok', '2026-08-12'),
    '/admin/operaciones/asignaciones?serviceRequestId=req-1&message=ok&fecha=2026-08-12'
  );
  assert.equal(
    addDateToAssignmentRedirect('/admin/operaciones/asignaciones?serviceRequestId=req-1&fecha=2026-08-13', '2026-08-12'),
    '/admin/operaciones/asignaciones?serviceRequestId=req-1&fecha=2026-08-13'
  );
  assert.equal(addDateToAssignmentRedirect('/admin/operaciones', '2026-08-12'), '/admin/operaciones');
});

test('date navigation forces a server refresh and clears stale selected request', () => {
  const script = buildAssignmentDateNavigationScript();
  assert.match(script, /window\.location\.assign/);
  assert.match(script, /searchParams\.delete\('serviceRequestId'\)/);
  assert.match(script, /assignmentDateFilter/);
  assert.match(script, /clearAssignmentDateFilter/);
  assert.match(script, /searchParams\.set\('allDates', '1'\)/);
});

test('assignment date guard runs before the active assignment route and manual confirmation remains independent of WhatsApp', () => {
  const server = readSource('src/server.js');
  const workerStats = readSource('src/routes/dispatchWorkerStats.js');
  const ops = readSource('src/routes/dispatchOpsExtras.js');

  assert.ok(server.indexOf('dispatchWorkerStatsRouter(prisma)') < server.indexOf('dispatchOpsExtrasRouter(prisma)'));
  assert.match(workerStats, /router\.use\('\/asignaciones', requireOps, dispatchAssignmentDateGuard\(prisma\)\)/);
  assert.match(ops, /router\.post\('\/asignaciones\/confirmar'/);
  assert.match(ops, /status: 'CONFIRMED'/);
  assert.match(ops, /router\.post\('\/asignaciones\/no-confirmado'/);
  assert.match(ops, /status: 'NO_CONFIRMO'/);
  assert.doesNotMatch(ops, /DISPATCH_META_ACCESS_TOKEN|DISPATCH_META_PHONE_NUMBER_ID/);
});
