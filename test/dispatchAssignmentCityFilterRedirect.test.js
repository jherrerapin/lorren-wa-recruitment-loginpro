import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addCityFilterToAssignmentRedirect,
  dispatchAssignmentDateGuard
} from '../src/routes/dispatchAssignmentDateGuard.js';

test('assignment redirect preserves an explicit multi-city selection from the board URL', () => {
  const target = '/admin/operaciones/asignaciones?serviceRequestId=req-1&message=ok&fecha=2026-09-28';
  const source = 'https://lorren.example/admin/operaciones/asignaciones?serviceRequestId=req-1&fecha=2026-09-28&cityFilter=1&operationalCityIds=city-bogota&operationalCityIds=city-neiva';

  assert.equal(
    addCityFilterToAssignmentRedirect(target, source),
    '/admin/operaciones/asignaciones?serviceRequestId=req-1&message=ok&fecha=2026-09-28&cityFilter=1&operationalCityIds=city-bogota&operationalCityIds=city-neiva'
  );
});

test('explicit empty city selection remains empty instead of expanding back to all cities', () => {
  const target = '/admin/operaciones/asignaciones?serviceRequestId=req-1&fecha=2026-09-28';
  const source = 'https://lorren.example/admin/operaciones/asignaciones?cityFilter=1&fecha=2026-09-28';

  assert.equal(
    addCityFilterToAssignmentRedirect(target, source),
    '/admin/operaciones/asignaciones?serviceRequestId=req-1&fecha=2026-09-28&cityFilter=1'
  );
});

test('assignment redirect ignores unrelated referrers and never copies their query state', () => {
  const target = '/admin/operaciones/asignaciones?serviceRequestId=req-1';
  const source = 'https://lorren.example/admin/operaciones/personal?cityFilter=1&operationalCityIds=city-neiva';

  assert.equal(addCityFilterToAssignmentRedirect(target, source), target);
});

test('POST assignment redirect keeps the server date and the city filter together', async () => {
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
    body: { serviceRequestId: 'req-1', workerId: 'worker-1' },
    userRole: 'dev',
    get(name) {
      if (name === 'referer') {
        return 'https://lorren.example/admin/operaciones/asignaciones?serviceRequestId=req-1&fecha=2026-09-28&cityFilter=1&operationalCityIds=city-neiva';
      }
      return null;
    }
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
    '/admin/operaciones/asignaciones?serviceRequestId=req-1&message=ok&fecha=2026-09-28&cityFilter=1&operationalCityIds=city-neiva'
  );
});
