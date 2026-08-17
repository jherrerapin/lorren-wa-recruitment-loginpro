import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  WORKER_REST_ACTION,
  WORKER_REST_ENTITY_TYPE,
  WORKER_REST_REASONS,
  loadWorkerRestAssignments,
  saveWorkerRestAssignment
} from '../src/modules/dispatch-payroll/application/payrollReport.js';

function makePrisma({ contractType = 'DIRECTO', assignments = [] } = {}) {
  const events = [];
  let sequence = 0;
  const prisma = {
    dispatchWorker: {
      async findUnique({ where }) {
        if (where.id !== 'TEST-WORKER-1') return null;
        return { id: 'TEST-WORKER-1', fullName: 'Auxiliar de prueba', contractType };
      }
    },
    dispatchAssignment: {
      async findMany() {
        return assignments.map((assignment) => ({
          workerId: assignment.workerId || 'TEST-WORKER-1',
          worker: { fullName: 'Auxiliar de prueba' },
          serviceRequest: { id: assignment.serviceRequestId || 'TEST-REQUEST-1' }
        }));
      }
    },
    devAuditEvent: {
      async findMany({ where }) {
        return events
          .filter((event) => !where?.entityType || event.entityType === where.entityType)
          .filter((event) => !where?.action || event.action === where.action)
          .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
      },
      async create({ data }) {
        sequence += 1;
        const event = {
          ...data,
          id: `TEST-AUDIT-${sequence}`,
          createdAt: new Date(`2026-08-17T${String(10 + sequence).padStart(2, '0')}:00:00.000Z`)
        };
        events.push(event);
        return event;
      }
    }
  };
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma, events };
}

test('un Directo puede recibir descanso primero y justificación después sobre la misma entidad', async () => {
  const state = makePrisma();

  const pending = await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1',
    restDate: '2026-08-18',
    reason: ''
  });
  assert.equal(pending.reason, null);
  assert.equal(pending.dayAdjustment, 0);
  assert.equal(pending.requiresJustification, true);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].entityId, 'TEST-WORKER-1|2026-08-18');

  const justified = await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1',
    restDate: '2026-08-18',
    reason: WORKER_REST_REASONS.SUSPENSION
  });
  assert.equal(justified.reason, WORKER_REST_REASONS.SUSPENSION);
  assert.equal(justified.dayAdjustment, -1);
  assert.equal(justified.requiresJustification, true);
  assert.equal(state.events.length, 2);
  assert.equal(state.events[1].entityId, state.events[0].entityId);

  const loaded = await loadWorkerRestAssignments(state.prisma, {
    workerIds: ['TEST-WORKER-1'],
    from: '2026-08-18',
    to: '2026-08-18'
  });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].reason, WORKER_REST_REASONS.SUSPENSION);
  assert.equal(loaded[0].dayAdjustment, -1);
});

test('un descanso Directo sin campo de justificación sigue rechazándose en día hábil', async () => {
  const state = makePrisma();
  await assert.rejects(
    saveWorkerRestAssignment(state.prisma, {
      workerId: 'TEST-WORKER-1',
      restDate: '2026-08-18'
    }),
    /worker_rest_invalid/
  );
  assert.equal(state.events.length, 0);
});

test('la actualización de justificación conserva la confirmación previa de conflicto', async () => {
  const state = makePrisma({ assignments: [{ serviceRequestId: 'TEST-REQUEST-CONFLICT' }] });
  const pending = await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1',
    restDate: '2026-08-18',
    reason: '',
    allowAssignedRest: true
  });
  assert.equal(pending.assignmentConflictOverride, true);

  const updated = await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1',
    restDate: '2026-08-18',
    reason: WORKER_REST_REASONS.REMUNERADO
  });
  assert.equal(updated.reason, WORKER_REST_REASONS.REMUNERADO);
  assert.equal(updated.assignmentConflictOverride, true);
  assert.equal(state.events.length, 2);
});

test('Contratista conserva descanso sin motivo y la tarjeta reserva Justificación para Directos', async () => {
  const contractor = makePrisma({ contractType: 'CONTRATISTA' });
  const saved = await saveWorkerRestAssignment(contractor.prisma, {
    workerId: 'TEST-WORKER-1',
    restDate: '2026-08-18',
    reason: ''
  });
  assert.equal(saved.reason, null);
  assert.equal(saved.requiresJustification, false);

  const [view, board] = await Promise.all([
    readFile('src/views/operacionesAsignacionesConfirmacion.ejs', 'utf8'),
    readFile('src/public/dispatch-assignment-board.js', 'utf8')
  ]);

  assert.match(view, /Contrato: <%= restWorker \? contractLabel\(restWorker\.contractType\) : 'No disponible' %>/);
  assert.doesNotMatch(view, /Sin justificación requerida/);
  assert.match(view, /restWorker\?\.contractType==='DIRECTO'/);
  assert.match(view, /data-rest-justification/);
  assert.match(view, /Editar justificación/);
  assert.match(view, /Guardar justificación/);
  assert.doesNotMatch(view, /descansos\/cancelar" onsubmit=/);

  assert.match(board, /function assignRestBatchWithoutJustification\(\)/);
  assert.match(board, /options\.deferJustification === true\) payload\.set\('reason', ''\)/);
  assert.match(board, /function openRestJustificationDialog\(button\)/);
  assert.match(board, /qsa\('\[data-rest-justification\]'\)/);
  assert.match(board, /await postRestWorker\(worker, origin, \{ includeReason: true \}\)/);
});

test('los eventos diferidos mantienen la autoridad canónica de descanso', async () => {
  const state = makePrisma();
  await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-18', reason: ''
  });
  await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-18', reason: WORKER_REST_REASONS.NO_REMUNERADA
  });

  assert.ok(state.events.every((event) => (
    event.entityType === WORKER_REST_ENTITY_TYPE && event.action === WORKER_REST_ACTION
  )));
  assert.equal(new Set(state.events.map((event) => event.entityId)).size, 1);
});
