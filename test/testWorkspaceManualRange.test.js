import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestWorkspacePayrollReport } from '../src/services/testWorkspacePayrollReport.js';

test('el rango del cálculo sigue las fechas manuales aunque difieran de la solicitud', async () => {
  const request = {
    id: 'request-original-date',
    source: 'DEV_TEST',
    serviceDate: new Date('2026-07-29T05:00:00.000Z'),
    clientName: 'Cliente real',
    operationPointName: 'Operación real',
    operationPoint: {
      id: 'point-real',
      clientId: 'client-real',
      name: 'Operación real',
      client: { id: 'client-real', name: 'Cliente real' }
    },
    assignments: [{
      id: 'assignment-test',
      workerId: 'worker-real',
      status: 'DEV_TEST_ASSIGNED',
      worker: {
        id: 'worker-real',
        fullName: 'Auxiliar real',
        documentType: 'CC',
        documentNumber: '1000000000',
        phone: '3000000000'
      },
      attendanceSession: {
        id: 'session-manual-other-date',
        source: 'DEV_TEST_MANUAL',
        arrivalReportedAt: new Date('2026-08-03T03:00:00.000Z'),
        departureReportedAt: new Date('2026-08-03T11:00:00.000Z'),
        expectedStartAt: new Date('2026-08-03T03:00:00.000Z'),
        expectedEndAt: new Date('2026-08-03T11:00:00.000Z'),
        workedMinutes: 480,
        validationStatus: 'MANUAL_VALIDATED',
        marks: []
      }
    }]
  };
  const prisma = {
    devAuditEvent: { findMany: async () => [] }
  };

  const report = await loadTestWorkspacePayrollReport(prisma, request);
  assert.deepEqual(report.range, { from: '2026-08-02', to: '2026-08-03' });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].totalMinutes, 480);
});
