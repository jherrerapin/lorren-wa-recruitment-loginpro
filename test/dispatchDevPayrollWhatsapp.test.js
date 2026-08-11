import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
import { loadPayrollReport } from '../src/modules/dispatch-payroll/application/payrollReport.js';
import {
  getDispatchWhatsappCloudConfig,
  getDispatchWhatsappStatus
} from '../src/services/dispatchWhatsappCloudConfig.js';
import { claimDispatchAssignmentConfirmation } from '../src/services/dispatchWhatsappAssignmentService.js';

function devTestSession() {
  return {
    id: 'session-dev-test',
    source: 'DEV_TEST_MANUAL',
    arrivalReportedAt: new Date('2026-07-29T13:00:00.000Z'),
    departureReportedAt: new Date('2026-07-29T21:00:00.000Z'),
    expectedStartAt: new Date('2026-07-29T13:00:00.000Z'),
    expectedEndAt: new Date('2026-07-29T21:00:00.000Z'),
    workedMinutes: null,
    validationStatus: 'MANUAL_VALIDATED',
    marks: [
      {
        markType: 'BREAK_START',
        clientCapturedAt: new Date('2026-07-29T17:00:00.000Z'),
        serverReceivedAt: new Date('2026-07-29T17:00:00.000Z')
      },
      {
        markType: 'BREAK_END',
        clientCapturedAt: new Date('2026-07-29T18:00:00.000Z'),
        serverReceivedAt: new Date('2026-07-29T18:00:00.000Z')
      }
    ],
    assignment: {
      id: 'assignment-dev-test',
      workerId: 'worker-dev-test',
      status: 'DEV_TEST_ASSIGNED',
      worker: {
        id: 'worker-dev-test',
        fullName: 'Sujeto de Prueba',
        documentType: 'CC',
        documentNumber: '1000000001',
        phone: '3000000000',
        isTestProfile: true
      },
      serviceRequest: {
        id: 'request-dev-test',
        source: 'DEV_TEST',
        clientName: 'Cliente Prueba',
        operationPointName: 'Operación Prueba',
        operationPoint: {
          id: 'point-dev-test',
          clientId: 'client-dev-test',
          name: 'Operación Prueba',
          client: { id: 'client-dev-test', name: 'Cliente Prueba' }
        }
      }
    }
  };
}

function payrollPrisma(session) {
  return {
    dispatchAttendanceSession: { findMany: async () => [session] },
    dispatchClient: {
      findMany: async () => [{
        id: 'client-dev-test',
        name: 'Cliente Prueba',
        isTestClient: true,
        operationPoints: [{ id: 'point-dev-test', name: 'Operación Prueba', clientId: 'client-dev-test' }]
      }]
    },
    dispatchWorker: {
      findMany: async () => [{ id: 'worker-dev-test', fullName: 'Sujeto de Prueba', documentNumber: '1000000001' }]
    },
    devAuditEvent: { findMany: async () => [] }
  };
}

test('Nómina calcula una jornada manual DEV cuando includeTest=true', async () => {
  const report = await loadPayrollReport(
    payrollPrisma(devTestSession()),
    {
      periodType: 'CUSTOM',
      from: '2026-07-29',
      to: '2026-07-29',
      workerId: 'worker-dev-test',
      includeTest: 'true'
    },
    { allowTestData: true, now: new Date('2026-07-29T15:00:00.000Z') }
  );

  assert.equal(report.filters.includeTest, true);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].workerId, 'worker-dev-test');
  assert.equal(report.rows[0].totalMinutes, 420);
  assert.equal(report.rows[0].totalHours, 7);
  assert.equal(report.totals.totalMinutes, 420);
});

test('Nómina normal sigue ocultando el sujeto y la jornada de prueba', async () => {
  const report = await loadPayrollReport(
    payrollPrisma(devTestSession()),
    { periodType: 'CUSTOM', from: '2026-07-29', to: '2026-07-29' },
    { allowTestData: true, now: new Date('2026-07-29T15:00:00.000Z') }
  );

  assert.equal(report.filters.includeTest, false);
  assert.equal(report.rows.length, 0);
  assert.equal(report.totals.totalMinutes, 0);
});

test('las líneas Cloud operativa y DEV usan scopes y variables separadas', () => {
  const operational = getDispatchWhatsappStatus('operational');
  const devTest = getDispatchWhatsappStatus('dev-test');
  const operationalConfig = getDispatchWhatsappCloudConfig('operational');
  const devConfig = getDispatchWhatsappCloudConfig('dev-test');

  assert.equal(operational.runtimeScope, 'operational');
  assert.equal(devTest.runtimeScope, 'dev-test');
  assert.notEqual(operationalConfig.scope, devConfig.scope);
  assert.ok(operationalConfig.missing.some((name) => name.startsWith('DISPATCH_META_')));
  assert.ok(devConfig.missing.some((name) => name.startsWith('DISPATCH_TEST_META_')));
});

test('la confirmación recibida por la línea DEV solo cambia estados DEV_TEST y exige evidencia', async () => {
  const calls = {};
  const tx = {
    dispatchAssignment: {
      updateMany: async (input) => {
        calls.assignmentUpdate = input;
        return { count: 1 };
      },
      findUnique: async () => ({ status: 'DEV_TEST_CONFIRMED' })
    },
    dispatchWhatsappConfirmation: {
      findFirst: async () => null,
      updateMany: async (input) => {
        calls.linkUpdate = input;
        return { count: 1 };
      }
    }
  };
  const fakePrisma = { $transaction: async (callback) => callback(tx) };

  const withoutEvidence = await claimDispatchAssignmentConfirmation({
    scope: 'dev-test',
    assignment: { id: 'assignment-dev-test', serviceRequestId: 'request-dev-test' },
    prismaClient: fakePrisma
  });
  assert.equal(withoutEvidence.shouldReply, false);
  assert.equal(calls.assignmentUpdate, undefined);

  const result = await claimDispatchAssignmentConfirmation({
    scope: 'dev-test',
    assignment: { id: 'assignment-dev-test', serviceRequestId: 'request-dev-test' },
    confirmationMessageId: 'wamid.inbound.dev-test',
    confirmationReceivedAt: new Date('2026-07-29T15:00:00.000Z'),
    prismaClient: fakePrisma
  });

  assert.deepEqual(calls.assignmentUpdate.where.status.in, ['DEV_TEST_ASSIGNED']);
  assert.equal(calls.assignmentUpdate.data.status, 'DEV_TEST_CONFIRMED');
  assert.equal(calls.linkUpdate.data.status, 'CONFIRMED_REPLY_PENDING');
  assert.equal(calls.linkUpdate.data.confirmationMessageId, 'wamid.inbound.dev-test');
  assert.equal(result.assignmentConfirmed, true);
  assert.equal(result.shouldReply, true);
});

test('las vistas modificadas conservan sintaxis EJS válida', async () => {
  const viewPaths = [
    new URL('../src/views/operacionesNomina.ejs', import.meta.url),
    new URL('../src/views/operacionesPruebasNomina.ejs', import.meta.url),
    new URL('../src/views/operacionesWhatsappEstado.ejs', import.meta.url)
  ];

  for (const viewPath of viewPaths) {
    const source = await readFile(viewPath, 'utf8');
    assert.doesNotThrow(() => ejs.compile(source, { filename: viewPath.pathname }));
  }
});
