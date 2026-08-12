import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  addDateToAssignmentRedirect,
  assignmentDateFromQuery,
  buildAssignmentAsyncNavigationScript,
  injectAssignmentClientBehavior,
  loadAssignmentDateContext,
  mergeAssignmentServiceRequests,
  stripAssignmentDateStatusNote
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
    },
    {
      id: 'request-next-day-legacy',
      serviceDate: new Date('2026-08-13T00:00:00.000Z'),
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
        return [
          { workerId: 'worker-2', serviceRequest: { serviceDate: new Date('2026-08-12T05:00:00.000Z') } },
          { workerId: 'worker-3', serviceRequest: { serviceDate: new Date('2026-08-13T00:00:00.000Z') } }
        ];
      }
    }
  };

  const context = await loadAssignmentDateContext(prisma, '2026-08-12', 'request-b');

  assert.equal(context.selectedDate, '2026-08-12');
  assert.equal(context.selectedServiceRequest.id, 'request-b');
  assert.deepEqual(context.serviceRequests.map((request) => request.id), ['request-a', 'request-b']);
  assert.equal(context.blockedWorkerIds.size, 0);
  assert.equal(context.assignedWorkerIdsOnSelectedDate.has('worker-2'), true);
  assert.equal(context.assignedWorkerIdsOnSelectedDate.has('worker-3'), false);
  assert.ok(captured.requestWhere.serviceDate.gte instanceof Date);
  assert.ok(captured.requestWhere.serviceDate.lt instanceof Date);
  assert.equal(captured.requestWhere.serviceDate.gte.toISOString(), '2026-08-12T00:00:00.000Z');
  assert.equal(captured.requestWhere.serviceDate.lt.toISOString(), '2026-08-13T05:00:00.000Z');
  assert.deepEqual(captured.assignmentWhere.serviceRequestId, { not: 'request-b' });
  assert.deepEqual(captured.assignmentWhere.status, { in: ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'] });
  assert.ok(captured.assignmentWhere.serviceRequest.is.serviceDate.gte instanceof Date);
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

test('date context is merged into the already loaded board without losing other dates', () => {
  const merged = mergeAssignmentServiceRequests(
    [
      { id: 'today', serviceDate: new Date('2026-08-12T05:00:00.000Z'), createdAt: new Date('2026-08-11T12:00:00.000Z') },
      { id: 'tomorrow', serviceDate: new Date('2026-08-13T05:00:00.000Z'), createdAt: new Date('2026-08-11T12:00:00.000Z') }
    ],
    [
      { id: 'today', serviceDate: new Date('2026-08-12T05:00:00.000Z'), createdAt: new Date('2026-08-11T13:00:00.000Z') },
      { id: 'older-exact-date', serviceDate: new Date('2026-07-01T05:00:00.000Z'), createdAt: new Date('2026-06-30T12:00:00.000Z') }
    ]
  );

  assert.deepEqual(merged.map((request) => request.id), ['tomorrow', 'today', 'older-exact-date']);
  assert.equal(merged.find((request) => request.id === 'today').createdAt.toISOString(), '2026-08-11T13:00:00.000Z');
});

test('calendar change delegates to the existing async board loader and never performs a full-page navigation', () => {
  const script = buildAssignmentAsyncNavigationScript();

  assert.match(script, /assignmentDateFilter/);
  assert.match(script, /searchParams\.set\('fecha', value\)/);
  assert.match(script, /searchParams\.delete\('serviceRequestId'\)/);
  assert.match(script, /bridgeLink\.href = url\.toString\(\)/);
  assert.match(script, /bridgeLink\.click\(\)/);
  assert.doesNotMatch(script, /window\.location\.(?:assign|replace)|location\.href\s*=/);
});

test('selection preserves page and list positions before the async board DOM replacement', () => {
  const script = buildAssignmentAsyncNavigationScript();

  assert.match(script, /new MutationObserver/);
  assert.match(script, /window\.scrollY/);
  assert.match(script, /#workerList/);
  assert.match(script, /#requestList/);
  assert.match(script, /window\.scrollTo\(0, pageY\)/);
  assert.match(script, /closest\('\.select-request-link'\)/);
});

test('assignment UI removes active-filter phrase and injects the async navigation guard once', () => {
  const rendered = '<body><section><div class="date-note" id="assignmentDateNote"><strong>Filtro activo:</strong> <span id="assignmentDateLabel">2026-08-12</span></div><div>tablero</div></section></body>';
  const stripped = stripAssignmentDateStatusNote(rendered);
  assert.doesNotMatch(stripped, /Filtro activo|assignmentDateNote|assignmentDateLabel/);
  assert.match(stripped, /tablero/);

  const injected = injectAssignmentClientBehavior(rendered);
  assert.match(injected, /dispatch-assignment-async-navigation/);
  assert.equal((injected.match(/dispatch-assignment-async-navigation/g) || []).length, 1);
  assert.equal(injectAssignmentClientBehavior(injected), injected);
});

test('assignment view retains its native async board replacement used by the bridge', () => {
  const view = readSource('src/views/operacionesAsignacionesConfirmacion.ejs');

  assert.match(view, /async function replaceBoardFromUrl/);
  assert.match(view, /select-request-link[^\n]*addEventListener\('click'/);
  assert.match(view, /replaceBoardFromUrl\(url\.toString\(\),true\)/);
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
