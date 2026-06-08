import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { dispatchOpsExtrasRouter } from '../src/routes/dispatchOpsExtras.js';

function serviceRequest(id, serviceDate) {
  return {
    id,
    serviceDate,
    assignments: [],
    requiredWorkers: 1,
    status: 'PENDING_ASSIGNMENT',
    clientName: 'Cliente',
    operationPointName: 'Operación',
    cityName: 'Bogotá',
    service: null
  };
}

test('active assignment route sends same-day worker IDs to the rendered board', async (t) => {
  const selectedDate = new Date('2026-06-08T15:30:00.000Z');
  const capturedAssignmentQueries = [];
  let workerQueryCall = 0;
  const prisma = {
    city: { findMany: async () => [] },
    dispatchWorker: {
      findMany: async () => {
        workerQueryCall += 1;
        return workerQueryCall === 1 ? [{ id: 'worker-1', cities: [], vacancies: [] }] : [];
      }
    },
    dispatchServiceRequest: {
      findMany: async () => [
        serviceRequest('request-selected', selectedDate),
        serviceRequest('request-other', new Date('2026-06-08T00:00:00.000Z'))
      ]
    },
    dispatchClient: { findMany: async () => [] },
    dispatchAssignment: {
      findMany: async (query) => {
        capturedAssignmentQueries.push(query);
        return [{ workerId: 'worker-1' }];
      }
    }
  };

  const app = express();
  app.use((req, res, next) => {
    req.session = { userRole: 'dev' };
    res.render = (view, locals) => res.json({
      view,
      markedWorkerIds: [...locals.assignedWorkerIdsOnSelectedDate]
    });
    next();
  });
  app.use('/admin/operaciones', dispatchOpsExtrasRouter(prisma));

  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/admin/operaciones/asignaciones?serviceRequestId=request-selected`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    view: 'operacionesAsignacionesConfirmacion',
    markedWorkerIds: ['worker-1']
  });

  assert.equal(capturedAssignmentQueries.length, 1);
  assert.deepEqual(capturedAssignmentQueries[0].where, {
    serviceRequestId: { not: 'request-selected' },
    status: { in: ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'] },
    serviceRequest: {
      serviceDate: {
        gte: new Date('2026-06-08T00:00:00.000Z'),
        lt: new Date('2026-06-09T00:00:00.000Z')
      }
    }
  });
});
