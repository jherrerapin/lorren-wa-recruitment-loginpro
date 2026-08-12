import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  addDateToAssignmentRedirect,
  assignmentDateFromQuery,
  dispatchAssignmentDateGuard,
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

test('bare assignment entry makes today explicit for the downstream assignment route', async () => {
  const expectedToday = assignmentDateFromQuery({});
  const prisma = {
    dispatchServiceRequest: { findMany: async () => [] },
    dispatchAssignment: { findMany: async () => [] }
  };
  const req = { method: 'GET', query: {} };
  const res = { render() {} };
  let nextCalls = 0;

  await dispatchAssignmentDateGuard(prisma)(req, res, () => { nextCalls += 1; });

  assert.equal(nextCalls, 1);
  assert.equal(req.query.fecha, expectedToday);
  assert.equal(req.query.date, undefined);
  assert.equal(req.query.serviceRequestId, undefined);
});

test('allDates remains explicit and is not replaced by today', async () => {
  let serviceRequestQueries = 0;
  const prisma = {
    dispatchServiceRequest: { findMany: async () => { serviceRequestQueries += 1; return []; } },
    dispatchAssignment: { findMany: async () => [] }
  };
  const req = { method: 'GET', query: { allDates: '1' } };
  const res = { render() {} };

  await dispatchAssignmentDateGuard(prisma)(req, res, () => {});

  assert.equal(req.query.fecha, undefined);
  assert.equal(req.query.allDates, '1');
  assert.equal(serviceRequestQueries, 0);
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

  const defaultContext = await loadAssignmentDateContext(prisma, '2026-08-12');
  assert.equal(defaultContext.selectedServiceRequest.id, 'request-a');
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

test('server date guard is the sole date authority and does not inject client patches or mix dates', () => {
  const guard = readSource('src/routes/dispatchAssignmentDateGuard.js');

  assert.match(guard, /nextLocals\.serviceRequests = context\.serviceRequests/);
  assert.match(guard, /selectedAssignmentDate: selectedDate \|\| ''/);
  assert.match(guard, /query\.fecha = selectedDate/);
  assert.doesNotMatch(guard, /mergeAssignmentServiceRequests|buildAssignmentAsyncNavigationScript|injectAssignmentClientBehavior/);
  assert.doesNotMatch(guard, /bridgeLink|MutationObserver|stopImmediatePropagation|window\.location/);
});

test('assignment view renders the selected date and uses one dedicated board controller', () => {
  const view = readSource('src/views/operacionesAsignacionesConfirmacion.ejs');

  assert.match(view, /safeAssignmentDate/);
  assert.match(view, /id="assignmentDateFilter" value="<%= safeAssignmentDate %>"/);
  assert.match(view, /src="\/public\/dispatch-assignment-board\.js"/);
  assert.doesNotMatch(view, /Filtro activo:|assignmentDateNote|assignmentDateLabel/);
  assert.doesNotMatch(view, /replaceBoardFromUrl|maybeAutoSelectFirstVisibleRequest|BOARD_POS_KEY/);
});

test('board controller fetches one server state for date/selection and updates granular regions without page navigation', () => {
  const controller = readSource('src/public/dispatch-assignment-board.js');

  assert.match(controller, /async function changeOperationalDate\(value\)/);
  assert.match(controller, /async function selectRequest\(link\)/);
  assert.match(controller, /await loadBoard\(url/);
  assert.match(controller, /workerList\.innerHTML = nextWorkerList\.innerHTML/);
  assert.match(controller, /requestList\.innerHTML = nextRequestList\.innerHTML/);
  assert.match(controller, /currentAssignmentBody\.innerHTML = nextAssignmentBody\.innerHTML/);
  assert.match(controller, /history\.replaceState\(null, '', url\.toString\(\)\)/);
  assert.match(controller, /new AbortController\(\)/);

  assert.doesNotMatch(controller, /bridgeLink|MutationObserver|stopImmediatePropagation/);
  assert.doesNotMatch(controller, /window\.location\.(?:assign|replace|reload)|location\.href\s*=/);
  assert.doesNotMatch(controller, /board\.innerHTML\s*=/);
  assert.doesNotMatch(controller, /maybeAutoSelectFirstVisibleRequest|restoreBoardPosition|BOARD_POS_KEY/);
});

test('calendar date remains the DOM source of truth and all-dates is explicit', () => {
  const controller = readSource('src/public/dispatch-assignment-board.js');

  assert.match(controller, /return qs\('#assignmentDateFilter'\)\?\.value \|\| ''/);
  assert.match(controller, /url\.searchParams\.set\('fecha', date\)/);
  assert.match(controller, /url\.searchParams\.delete\('serviceRequestId'\)/);
  assert.match(controller, /url\.searchParams\.set\('allDates', '1'\)/);
  assert.match(controller, /dateInput\.value = date \|\| ''/);
});

test('legacy assignment template helper cannot hide requests already filtered by the server date authority', () => {
  const helper = readSource('src/public/assignment-template-sync.js');

  assert.doesNotMatch(helper, /function hideExpiredWithoutDate/);
  assert.doesNotMatch(helper, /hideExpiredWithoutDate\(\)/);
  assert.doesNotMatch(helper, /Solo se muestran solicitudes vigentes/);
  assert.doesNotMatch(helper, /card\.hidden\s*=\s*expired/);
  assert.match(helper, /function addRequestCrudActions\(\)/);
  assert.match(helper, /function wrapWhatsappFetch\(\)/);
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
