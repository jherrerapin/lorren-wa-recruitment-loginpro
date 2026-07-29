import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPayrollReport } from '../src/modules/dispatch-payroll/application/payrollReport.js';

function testSession() {
  const worker = {
    id: 'worker-test-1',
    fullName: 'Sujeto Nómina Prueba',
    documentType: 'CC',
    documentNumber: '1000000001',
    phone: '3000000001',
    isTestProfile: true
  };
  const client = { id: 'client-1', name: 'Cliente cálculo' };
  const operationPoint = {
    id: 'point-1',
    clientId: client.id,
    name: 'Operación cálculo',
    client
  };
  const serviceRequest = {
    id: 'request-test-1',
    source: 'DEV_TEST',
    clientName: client.name,
    operationPointName: operationPoint.name,
    operationPoint
  };
  return {
    id: 'session-test-1',
    assignmentId: 'assignment-test-1',
    expectedStartAt: new Date('2026-07-28T13:00:00.000Z'),
    expectedEndAt: new Date('2026-07-28T21:00:00.000Z'),
    arrivalReportedAt: new Date('2026-07-28T13:00:00.000Z'),
    departureReportedAt: new Date('2026-07-28T21:00:00.000Z'),
    validationStatus: 'MANUAL_VALIDATED',
    attendanceStatus: 'COMPLETED',
    workedMinutes: null,
    source: 'DEV_TEST_MANUAL',
    marks: [
      {
        id: 'mark-arrival',
        markType: 'ARRIVAL',
        serverReceivedAt: new Date('2026-07-28T13:00:00.000Z'),
        clientCapturedAt: new Date('2026-07-28T13:00:00.000Z')
      },
      {
        id: 'mark-break-start',
        markType: 'BREAK_START',
        serverReceivedAt: new Date('2026-07-28T17:00:00.000Z'),
        clientCapturedAt: new Date('2026-07-28T17:00:00.000Z')
      },
      {
        id: 'mark-break-end',
        markType: 'BREAK_END',
        serverReceivedAt: new Date('2026-07-28T18:00:00.000Z'),
        clientCapturedAt: new Date('2026-07-28T18:00:00.000Z')
      },
      {
        id: 'mark-departure',
        markType: 'DEPARTURE',
        serverReceivedAt: new Date('2026-07-28T21:00:00.000Z'),
        clientCapturedAt: new Date('2026-07-28T21:00:00.000Z')
      }
    ],
    assignment: {
      id: 'assignment-test-1',
      workerId: worker.id,
      worker,
      serviceRequest
    }
  };
}

function prismaMock() {
  const session = testSession();
  return {
    dispatchAttendanceSession: {
      async findMany() { return [session]; }
    },
    dispatchClient: {
      async findMany() {
        return [{
          id: 'client-1',
          name: 'Cliente cálculo',
          isActive: true,
          operationPoints: [{ id: 'point-1', name: 'Operación cálculo', clientId: 'client-1' }]
        }];
      }
    },
    dispatchWorker: {
      async findMany() {
        return [{ id: 'worker-test-1', fullName: 'Sujeto Nómina Prueba', documentNumber: '1000000001' }];
      }
    },
    devAuditEvent: {
      async findMany() { return []; }
    }
  };
}

const query = {
  periodType: 'CUSTOM',
  from: '2026-07-28',
  to: '2026-07-28',
  operationPointId: 'point-1',
  includeTest: 'true'
};

test('una jornada DEV_TEST_MANUAL genera una fila calculada al habilitar datos de prueba', async () => {
  const report = await loadPayrollReport(prismaMock(), query, {
    allowTestData: true,
    now: new Date('2026-07-28T22:00:00.000Z')
  });

  assert.equal(report.filters.includeTest, true);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].workerId, 'worker-test-1');
  assert.equal(report.rows[0].totalMinutes, 7 * 60);
  assert.equal(report.rows[0].ordinaryMinutes, 7 * 60);
  assert.equal(report.rows[0].overtimeMinutes, 0);
  assert.equal(report.rows[0].status, 'CALCULADO');
});

test('la misma jornada queda fuera cuando el modo de prueba no está autorizado', async () => {
  const report = await loadPayrollReport(prismaMock(), query, {
    allowTestData: false,
    now: new Date('2026-07-28T22:00:00.000Z')
  });

  assert.equal(report.filters.includeTest, false);
  assert.equal(report.rows.length, 0);
  assert.equal(report.totals.totalMinutes, 0);
});
