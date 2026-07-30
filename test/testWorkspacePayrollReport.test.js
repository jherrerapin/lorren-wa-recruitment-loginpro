import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestWorkspacePayrollReport } from '../src/services/testWorkspacePayrollReport.js';

test('calcula únicamente la jornada DEV_TEST_MANUAL del auxiliar real seleccionado', async () => {
  const request = {
    id: 'request-test',
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
    assignments: [
      {
        id: 'assignment-test',
        workerId: 'worker-real',
        status: 'DEV_TEST_ASSIGNED',
        worker: {
          id: 'worker-real',
          fullName: 'Auxiliar real',
          documentType: 'CC',
          documentNumber: '1000000000',
          phone: '3000000000',
          isTestProfile: false
        },
        attendanceSession: {
          id: 'session-test',
          source: 'DEV_TEST_MANUAL',
          arrivalReportedAt: new Date('2026-07-30T03:00:00.000Z'),
          departureReportedAt: new Date('2026-07-30T11:00:00.000Z'),
          expectedStartAt: new Date('2026-07-30T03:00:00.000Z'),
          expectedEndAt: new Date('2026-07-30T11:00:00.000Z'),
          workedMinutes: 480,
          validationStatus: 'MANUAL_VALIDATED',
          marks: []
        }
      },
      {
        id: 'assignment-operational-session',
        workerId: 'worker-other',
        worker: { id: 'worker-other', fullName: 'Otro auxiliar' },
        attendanceSession: {
          id: 'session-operational',
          source: 'WORKER_PORTAL',
          arrivalReportedAt: new Date('2026-07-30T03:00:00.000Z'),
          departureReportedAt: new Date('2026-07-30T11:00:00.000Z'),
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
  assert.equal(report.rows[0].workerId, 'worker-real');
  assert.equal(report.rows[0].totalMinutes, 480);
  assert.equal(report.rows[0].ordinaryMinutes, 420);
  assert.equal(report.rows[0].overtimeMinutes, 60);
  assert.equal(report.rows[0].conceptMinutes.RNO, 420);
  assert.equal(report.rows[0].conceptMinutes.HENO, 60);
  assert.equal(report.totals.workers, 1);
});

test('sin sesiones manuales devuelve un reporte vacío y no consulta nómina operativa', async () => {
  let policyQueries = 0;
  const prisma = {
    devAuditEvent: { findMany: async () => { policyQueries += 1; return []; } }
  };
  const report = await loadTestWorkspacePayrollReport(prisma, {
    id: 'request-empty',
    serviceDate: new Date('2026-07-29T05:00:00.000Z'),
    operationPoint: { clientId: 'client-real' },
    assignments: []
  });
  assert.equal(report.rows.length, 0);
  assert.equal(report.totals.totalMinutes, 0);
  assert.equal(policyQueries, 0);
});
