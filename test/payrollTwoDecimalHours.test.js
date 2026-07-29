import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePayrollConceptReport,
  minutesToDecimalHours
} from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function session({ minutes, id = `session-${minutes}` }) {
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
      workerId: 'worker-decimals',
      worker: {
        id: 'worker-decimals',
        fullName: 'Auxiliar Decimales',
        documentType: 'CC',
        documentNumber: '1000000001',
        phone: '3000000001'
      },
      serviceRequest: {
        clientName: 'Cliente prueba',
        operationPointName: 'Operación prueba',
        operationPoint: {
          id: 'point-decimals',
          clientId: 'client-decimals',
          name: 'Operación prueba',
          client: { id: 'client-decimals', name: 'Cliente prueba' }
        }
      }
    }
  };
}

test('convierte minutos a horas con máximo dos decimales', () => {
  assert.equal(minutesToDecimalHours(500), 8.33);
  assert.equal(minutesToDecimalHours(455), 7.58);
  assert.equal(minutesToDecimalHours(450), 7.5);
  assert.equal(minutesToDecimalHours(480), 8);
});

test('el reporte usa dos decimales sin alterar los minutos originales', () => {
  const report = calculatePayrollConceptReport({
    sessions: [session({ minutes: 500 })],
    policiesByClientId: new Map(),
    compensationByWorkerDate: new Map(),
    range: { from: '2026-07-27', to: '2026-07-27' }
  });
  const row = report.rows[0];

  assert.equal(row.totalMinutes, 500);
  assert.equal(row.totalHours, 8.33);
  assert.equal(row.ordinaryMinutes, 420);
  assert.equal(row.ordinaryHours, 7);
  assert.equal(row.overtimeMinutes, 80);
  assert.equal(row.overtimeHours, 1.33);
  assert.equal(row.conceptMinutes.HEDO, 80);
  assert.equal(row.conceptHours.HEDO, 1.33);
  assert.equal(report.totals.totalHours, 8.33);
});
