import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {
  buildProgrammingReportHtml,
  loadProgrammingReportData,
  loadProgrammingWorkerAbsences
} from '../src/services/dispatchProgrammingPdfService.js';
import { buildProgrammingExcelBuffer } from '../src/routes/dispatchProgrammingNotifications.js';

const DATE_KEY = '2026-08-15';

function restEvent({ workerId, reason, status = 'ACTIVE', createdAt }) {
  return {
    entityType: 'DISPATCH_WORKER_REST_ASSIGNMENT',
    entityId: `${workerId}|${DATE_KEY}`,
    action: 'WORKER_REST_ASSIGNMENT_UPDATED',
    createdAt: new Date(createdAt),
    metadata: {
      workerId,
      restDate: DATE_KEY,
      reason,
      status,
      originSundayDate: null,
      dayAdjustment: 0,
      requiresJustification: Boolean(reason),
      assignmentConflictOverride: false
    }
  };
}

function activeRestEvents() {
  return [
    restEvent({ workerId: 'TEST-WORKER-D', reason: 'VACACIONES', status: 'CANCELLED', createdAt: '2026-08-15T12:04:00.000Z' }),
    restEvent({ workerId: 'TEST-WORKER-D', reason: 'VACACIONES', createdAt: '2026-08-15T12:03:00.000Z' }),
    restEvent({ workerId: 'TEST-WORKER-C', reason: null, createdAt: '2026-08-15T12:02:00.000Z' }),
    restEvent({ workerId: 'TEST-WORKER-B', reason: 'INCAPACIDAD_ARL', createdAt: '2026-08-15T12:01:00.000Z' }),
    restEvent({ workerId: 'TEST-WORKER-A', reason: 'INCAPACIDAD_EPS', createdAt: '2026-08-15T12:00:00.000Z' })
  ];
}

function workerRows() {
  return [
    { id: 'TEST-WORKER-A', fullName: 'Auxiliar Prueba A', documentType: 'CC', documentNumber: 'TEST-DOC-A', contractType: 'DIRECTO' },
    { id: 'TEST-WORKER-B', fullName: 'Auxiliar Prueba B', documentType: 'CC', documentNumber: 'TEST-DOC-B', contractType: 'DIRECTO' },
    { id: 'TEST-WORKER-C', fullName: 'Auxiliar Prueba C', documentType: 'CC', documentNumber: 'TEST-DOC-C', contractType: 'CONTRATISTA' },
    { id: 'TEST-WORKER-D', fullName: 'Auxiliar Prueba D', documentType: 'CC', documentNumber: 'TEST-DOC-D', contractType: 'DIRECTO' }
  ];
}

function prismaForDailyReport({ requests = [] } = {}) {
  const events = activeRestEvents();
  return {
    dispatchServiceRequest: {
      async findMany() { return requests; }
    },
    devAuditEvent: {
      async findMany({ where }) {
        assert.equal(where.entityType, 'DISPATCH_WORKER_REST_ASSIGNMENT');
        assert.equal(where.action, 'WORKER_REST_ASSIGNMENT_UPDATED');
        return events;
      }
    },
    dispatchWorker: {
      async findMany({ where, select }) {
        const requested = new Set(where.id.in);
        assert.deepEqual(select, { id: true, fullName: true, documentType: true, documentNumber: true, contractType: true });
        return workerRows().filter((worker) => requested.has(worker.id));
      }
    }
  };
}

test('Programación lee descanso e incapacidades desde la autoridad canónica y excluye la novedad cancelada', async () => {
  const absences = await loadProgrammingWorkerAbsences(prismaForDailyReport(), DATE_KEY);

  assert.deepEqual(absences.map((item) => item.workerName), [
    'Auxiliar Prueba A',
    'Auxiliar Prueba B',
    'Auxiliar Prueba C'
  ]);
  assert.deepEqual(absences.map((item) => item.reasonLabel), [
    'Incapacidad EPS',
    'Incapacidad ARL',
    'Descanso'
  ]);
  assert.equal(absences.some((item) => item.workerId === 'TEST-WORKER-D'), false);
  assert.equal(absences[0].document, 'CC TEST-DOC-A');
  assert.equal(absences[2].contractType, 'CONTRATISTA');
});

test('PDF diario renderiza una sección separada con las novedades activas', async () => {
  const workerAbsences = await loadProgrammingWorkerAbsences(prismaForDailyReport(), DATE_KEY);
  const html = buildProgrammingReportHtml({
    selectedDate: DATE_KEY,
    requests: [],
    managedBy: 'Coordinación de prueba',
    includePending: true,
    overallSummary: { totalRequests: 0, completedRequests: 0, requiredWorkers: 0, assignedWorkers: 0, isComplete: false },
    workerAbsences,
    includeWorkerAbsences: true
  });

  assert.match(html, /Descansos e incapacidades reportados/);
  assert.match(html, /Auxiliar Prueba A/);
  assert.match(html, /Incapacidad EPS/);
  assert.match(html, /Incapacidad ARL/);
  assert.match(html, />Descanso</);
  assert.doesNotMatch(html, /Auxiliar Prueba D/);
});

test('Excel diario contiene la misma lista en una hoja independiente', async () => {
  const result = await buildProgrammingExcelBuffer(prismaForDailyReport(), {
    selectedDate: DATE_KEY,
    managedBy: 'Coordinación de prueba',
    includePending: true
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.buffer);
  const sheet = workbook.getWorksheet('Descansos e incapacidades');

  assert.ok(sheet);
  assert.deepEqual(result.workerAbsences.map((item) => item.reasonLabel), ['Incapacidad EPS', 'Incapacidad ARL', 'Descanso']);
  const values = [];
  sheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? ''))));
  const joined = values.join(' | ');
  assert.match(joined, /Auxiliar Prueba A/);
  assert.match(joined, /Incapacidad EPS/);
  assert.match(joined, /Incapacidad ARL/);
  assert.match(joined, /Descanso/);
  assert.doesNotMatch(joined, /Auxiliar Prueba D/);
});

test('PDF individual de una solicitud no agrega el listado global de novedades del día', async () => {
  let restReads = 0;
  const prisma = {
    dispatchServiceRequest: {
      async findMany() {
        return [{
          id: 'TEST-REQUEST-1',
          requiredWorkers: 0,
          status: 'PENDING_ASSIGNMENT',
          assignments: [],
          service: null
        }];
      }
    },
    devAuditEvent: {
      async findMany() {
        restReads += 1;
        return activeRestEvents();
      }
    }
  };

  const report = await loadProgrammingReportData(prisma, {
    selectedDate: DATE_KEY,
    requestId: 'TEST-REQUEST-1',
    includePending: true
  });

  assert.equal(report.includeWorkerAbsences, false);
  assert.deepEqual(report.workerAbsences, []);
  assert.equal(restReads, 0);
});
