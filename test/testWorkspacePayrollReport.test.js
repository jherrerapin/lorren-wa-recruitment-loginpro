import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestWorkspacePayrollReport } from '../src/services/testWorkspacePayrollReport.js';

test('calcula únicamente la jornada DEV_TEST_MANUAL y reconoce su exceso diario nocturno', async () => {
  const request = {
    id: 'TEST-REQUEST-PAYROLL',
    source: 'DEV_TEST',
    serviceDate: new Date('2026-07-29T05:00:00.000Z'),
    clientName: 'TEST Cliente',
    operationPointName: 'TEST Operación',
    operationPoint: {
      id: 'TEST-POINT',
      clientId: 'TEST-CLIENT',
      name: 'TEST Operación',
      client: { id: 'TEST-CLIENT', name: 'TEST Cliente' }
    },
    assignments: [
      {
        id: 'TEST-ASSIGNMENT',
        workerId: 'TEST-WORKER',
        status: 'DEV_TEST_ASSIGNED',
        worker: {
          id: 'TEST-WORKER',
          fullName: 'TEST Auxiliar',
          documentType: 'CC',
          documentNumber: 'TEST-DOC',
          phone: 'TEST-PHONE',
          isTestProfile: false
        },
        attendanceSession: {
          id: 'TEST-SESSION',
          source: 'DEV_TEST_MANUAL',
          arrivalReportedAt: new Date('2026-07-30T02:00:00.000Z'),
          departureReportedAt: new Date('2026-07-30T10:00:00.000Z'),
          expectedStartAt: new Date('2026-07-30T02:00:00.000Z'),
          expectedEndAt: new Date('2026-07-30T10:00:00.000Z'),
          workedMinutes: 480,
          validationStatus: 'MANUAL_VALIDATED',
          marks: []
        }
      },
      {
        id: 'TEST-ASSIGNMENT-OTHER',
        workerId: 'TEST-WORKER-OTHER',
        worker: { id: 'TEST-WORKER-OTHER', fullName: 'TEST Otro auxiliar' },
        attendanceSession: {
          id: 'TEST-SESSION-OTHER',
          source: 'WORKER_PORTAL',
          arrivalReportedAt: new Date('2026-07-30T02:00:00.000Z'),
          departureReportedAt: new Date('2026-07-30T10:00:00.000Z'),
          validationStatus: 'MANUAL_VALIDATED',
          marks: []
        }
      }
    ]
  };
  const prisma = {
    devAuditEvent: { findMany: async () => [] }
  };

  const report = await loadTestWorkspacePayrollReport(prisma, request);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].workerId, 'TEST-WORKER');
  assert.equal(report.rows[0].totalMinutes, 480);
  assert.equal(report.rows[0].ordinaryMinutes, 420);
  assert.equal(report.rows[0].overtimeMinutes, 60);
  assert.equal(report.rows[0].conceptMinutes.RNO, 420);
  assert.equal(report.rows[0].conceptMinutes.HENO, 60);
  assert.equal(report.totals.workers, 1);
});

test('sin sesiones manuales devuelve un reporte vacío y no consulta Gestión de Tiempo operativa', async () => {
  let policyQueries = 0;
  const prisma = {
    devAuditEvent: { findMany: async () => { policyQueries += 1; return []; } }
  };
  const report = await loadTestWorkspacePayrollReport(prisma, {
    id: 'TEST-REQUEST-EMPTY',
    serviceDate: new Date('2026-07-29T05:00:00.000Z'),
    operationPoint: { clientId: 'TEST-CLIENT' },
    assignments: []
  });
  assert.equal(report.rows.length, 0);
  assert.equal(report.totals.totalMinutes, 0);
  assert.equal(policyQueries, 0);
});
