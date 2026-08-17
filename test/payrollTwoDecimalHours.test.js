import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePayrollConceptReport,
  minutesToDecimalHours
} from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function session({ minutes, id = `TEST-SESSION-${minutes}` }) {
  const arrival = new Date('2026-07-27T13:00:00.000Z');
  const departure = new Date(arrival.getTime() + minutes * 60_000);
  return {
    id,
    arrivalReportedAt: arrival,
    departureReportedAt: departure,
    expectedStartAt: arrival,
    expectedEndAt: departure,
    workedMinutes: minutes,
    validationStatus: 'MANUAL_VALIDATED',
    marks: [],
    assignment: {
      workerId: 'TEST-WORKER-DECIMALS',
      worker: {
        id: 'TEST-WORKER-DECIMALS',
        fullName: 'TEST Auxiliar decimales',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-DECIMALS',
        phone: 'TEST-PHONE-DECIMALS'
      },
      serviceRequest: {
        clientName: 'TEST Cliente',
        operationPointName: 'TEST Operación',
        operationPoint: {
          id: 'TEST-POINT-DECIMALS',
          clientId: 'TEST-CLIENT-DECIMALS',
          name: 'TEST Operación',
          client: { id: 'TEST-CLIENT-DECIMALS', name: 'TEST Cliente' }
        }
      }
    }
  };
}

test('convierte minutos a horas con máximo un decimal', () => {
  assert.equal(minutesToDecimalHours(500), 8.3);
  assert.equal(minutesToDecimalHours(455), 7.6);
  assert.equal(minutesToDecimalHours(450), 7.5);
  assert.equal(minutesToDecimalHours(480), 8);
});

test('el reporte conserva el redondeo aunque 500 minutos aislados no sean hora extra semanal', () => {
  const report = calculatePayrollConceptReport({
    sessions: [session({ minutes: 500 })],
    policiesByClientId: new Map(),
    compensationByWorkerDate: new Map(),
    range: { from: '2026-07-27', to: '2026-07-27' }
  });
  const row = report.rows[0];

  assert.equal(row.totalMinutes, 500);
  assert.equal(row.totalHours, 8.3);
  assert.equal(row.ordinaryMinutes, 500);
  assert.equal(row.ordinaryHours, 8.3);
  assert.equal(row.overtimeMinutes, 0);
  assert.equal(row.overtimeHours, 0);
  assert.equal(row.conceptMinutes.HEDO, 0);
  assert.equal(row.conceptHours.HEDO, 0);
  assert.equal(report.totals.totalHours, 8.3);
});
