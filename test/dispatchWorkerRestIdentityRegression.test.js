import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import express from 'express';
import { dispatchOpsExtrasRouter } from '../src/routes/dispatchOpsExtras.js';

function makePrisma() {
  return {
    city: { findMany: async () => [] },
    dispatchWorker: {
      async findMany(query = {}) {
        if (query.where?.id?.in) {
          return [{
            id: 'TEST-REST-WORKER-1',
            fullName: 'Auxiliar descanso',
            contractType: 'CONTRATISTA',
            residenceCity: 'Bogotá',
            cities: []
          }];
        }
        if (query.select?.transportMode || query.select?.residenceLocality) return [];
        return [];
      }
    },
    dispatchServiceRequest: { findMany: async () => [] },
    dispatchClient: { findMany: async () => [] },
    dispatchAssignment: { findMany: async () => [] },
    devAuditEvent: {
      async findMany() {
        return [{
          entityId: 'TEST-REST-WORKER-1|2026-09-30',
          createdAt: new Date('2026-09-29T12:00:00.000Z'),
          metadata: {
            workerId: 'TEST-REST-WORKER-1',
            restDate: '2026-09-30',
            reason: null,
            status: 'ACTIVE'
          }
        }];
      }
    }
  };
}

test('la identidad de un descanso no depende de los filtros de auxiliares disponibles', async (t) => {
  const prisma = makePrisma();
  const app = express();
  app.use((req, res, next) => {
    req.session = { userRole: 'dev' };
    res.render = (view, locals) => res.json({
      view,
      workers: locals.workers.map((worker) => worker.id),
      restAssignments: locals.restAssignments.map((rest) => rest.workerId),
      restWorkers: locals.restWorkers.map((worker) => ({
        id: worker.id,
        fullName: worker.fullName,
        contractType: worker.contractType
      }))
    });
    next();
  });
  app.use('/admin/operaciones', dispatchOpsExtrasRouter(prisma));

  const server = app.listen(0);
  t.after(() => server.close());
  await once(server, 'listening');

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/admin/operaciones/asignaciones?fecha=2026-09-30`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    view: 'operacionesAsignacionesConfirmacion',
    workers: [],
    restAssignments: ['TEST-REST-WORKER-1'],
    restWorkers: [{
      id: 'TEST-REST-WORKER-1',
      fullName: 'Auxiliar descanso',
      contractType: 'CONTRATISTA'
    }]
  });
});

test('la tarjeta de descanso usa la colección dedicada de identidades', async () => {
  const view = await readFile('src/views/operacionesAsignacionesConfirmacion.ejs', 'utf8');
  assert.match(view, /safeRestWorkers/);
  assert.match(view, /safeRestWorkers\.find\(\(worker\)=>worker\.id===rest\.workerId\)/);
  assert.doesNotMatch(view, /const restWorker=workers\.find\(/);
});
