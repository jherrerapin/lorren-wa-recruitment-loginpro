import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  addCityFilterToAssignmentRedirect,
  dispatchAssignmentDateGuard
} from '../src/routes/dispatchAssignmentDateGuard.js';

const boardSource = fs.readFileSync('src/public/dispatch-assignment-board.js', 'utf8');

test('tablero serializa el filtro multiciudad en mutaciones asincronas y sincroniza la UI con el servidor', () => {
  assert.match(boardSource, /function currentCityFilterState\(/);
  assert.match(boardSource, /function appendCityFilterState\(/);
  assert.match(boardSource, /function syncCityFilterUi\(/);
  assert.match(boardSource, /function encodeForm\([\s\S]*return appendCityFilterState\(params\)/);
  assert.match(boardSource, /payload\.set\('workerId', workerId\);\s*appendCityFilterState\(payload\)/);
  assert.match(boardSource, /appendCityFilterState\(url\.searchParams\);\s*return url;/);
  assert.match(boardSource, /syncCityFilterUi\(nextDocument\);/);
  assert.match(boardSource, /window\.scrollTo\(0, pageY\)/);
  assert.doesNotMatch(boardSource, /window\.location\.(?:reload|assign|replace)\(/);
});

test('redirect acepta estado multiciudad explicito sin depender del Referer', () => {
  assert.equal(
    addCityFilterToAssignmentRedirect(
      '/admin/operaciones/asignaciones?serviceRequestId=req-1&fecha=2026-09-28',
      { cityFilter: '1', operationalCityIds: ['city-bogota', 'city-neiva'] }
    ),
    '/admin/operaciones/asignaciones?serviceRequestId=req-1&fecha=2026-09-28&cityFilter=1&operationalCityIds=city-bogota&operationalCityIds=city-neiva'
  );
});

test('POST asincrono conserva ciudades enviadas en body aunque no exista Referer', async () => {
  const prisma = {
    city: {
      findMany: async () => [
        { id: 'city-bogota', name: 'Bogotá' },
        { id: 'city-neiva', name: 'Neiva' }
      ]
    },
    dispatchServiceRequest: {
      findUnique: async () => ({
        serviceDate: new Date('2026-09-28T05:00:00.000Z'),
        cityName: 'Neiva'
      })
    },
    dispatchWorker: {
      findUnique: async () => ({ cities: [{ city: { name: 'Neiva' } }] })
    }
  };
  const req = {
    method: 'POST',
    originalUrl: '/admin/operaciones/asignaciones/assign',
    query: {},
    body: {
      serviceRequestId: 'req-1',
      workerId: 'worker-1',
      cityFilter: '1',
      operationalCityIds: ['city-bogota', 'city-neiva']
    },
    userRole: 'dev',
    get() { return null; }
  };
  let redirectedTo = null;
  const res = {
    redirect(url) { redirectedTo = url; },
    status() { return this; },
    send() {}
  };

  await dispatchAssignmentDateGuard(prisma)(req, res, () => {});
  res.redirect('/admin/operaciones/asignaciones?serviceRequestId=req-1&message=ok');

  assert.equal(
    redirectedTo,
    '/admin/operaciones/asignaciones?serviceRequestId=req-1&message=ok&fecha=2026-09-28&cityFilter=1&operationalCityIds=city-bogota&operationalCityIds=city-neiva'
  );
});
