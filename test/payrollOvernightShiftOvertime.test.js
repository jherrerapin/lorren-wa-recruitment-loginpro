import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayrollConceptReport } from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function overnightSession() {
  return {
    id: 'session-overnight-21-to-05',
    arrivalReportedAt: new Date('2026-07-29T02:00:00.000Z'),
    departureReportedAt: new Date('2026-07-29T10:00:00.000Z'),
    expectedStartAt: new Date('2026-07-29T02:00:00.000Z'),
    expectedEndAt: new Date('2026-07-29T10:00:00.000Z'),
    workedMinutes: 480,
    validationStatus: 'MANUAL_VALIDATED',
    marks: [],
    assignment: {
      workerId: 'worker-test',
      worker: {
        id: 'worker-test',
        fullName: 'Sujeto de prueba',
        documentType: 'CC',
        documentNumber: '1000000000',
        phone: '3000000000'
      },
      serviceRequest: {
        clientName: 'Cliente prueba',
        operationPointName: 'Operación prueba',
        operationPoint: {
          id: 'point-test',
          clientId: 'client-test',
          name: 'Operación prueba',
          client: { id: 'client-test', name: 'Cliente prueba' }
        }
      }
    }
  };
}

test('turno nocturno 21:00 a 05:00 conserva una sola jornada para el límite diario', () => {
  const report = calculatePayrollConceptReport({
    sessions: [overnightSession()],
    policiesByClientId: new Map(),
    compensationByWorkerDate: new Map(),
    range: { from: '2026-07-28', to: '2026-07-29' }
  });

  assert.equal(report.rows.length, 1);
  const row = report.rows[0];
  assert.equal(row.totalMinutes, 480);
  assert.equal(row.ordinaryMinutes, 420);
  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.conceptMinutes.RNO, 420);
  assert.equal(row.conceptMinutes.HENO, 60);
  assert.equal(row.conceptMinutes.HEDO, 0);

  assert.equal(row.daily.length, 2);
  assert.equal(row.daily[0].dateKey, '2026-07-28');
  assert.equal(row.daily[0].ordinaryMinutes, 180);
  assert.equal(row.daily[0].overtimeMinutes, 0);
  assert.equal(row.daily[1].dateKey, '2026-07-29');
  assert.equal(row.daily[1].ordinaryMinutes, 240);
  assert.equal(row.daily[1].overtimeMinutes, 60);
});
