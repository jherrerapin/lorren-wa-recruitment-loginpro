import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_OVERTIME_RECOGNITION_MINUTES,
  calculatePayrollConceptReport
} from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function session({ minutes, arrivalAt = '2026-07-27T13:00:00.000Z', id = `session-${minutes}` }) {
  const arrival = new Date(arrivalAt);
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

function reportFor(sessionValue, range = { from: '2026-07-27', to: '2026-07-27' }) {
  return calculatePayrollConceptReport({
    sessions: [sessionValue],
    policiesByClientId: new Map(),
    compensationByWorkerDate: new Map(),
    range
  }).rows[0];
}

test('el umbral mínimo de horas extra es de treinta minutos', () => {
  assert.equal(MIN_OVERTIME_RECOGNITION_MINUTES, 30);
});

test('veintinueve minutos de exceso no se reconocen como extra', () => {
  const row = reportFor(session({ minutes: 7 * 60 + 29 }));
  assert.equal(row.totalMinutes, 449);
  assert.equal(row.ordinaryMinutes, 420);
  assert.equal(row.overtimeMinutes, 0);
  assert.equal(row.unrecognizedOvertimeMinutes, 29);
  assert.equal(row.conceptMinutes.HEDO, 0);
  assert.ok(row.novelties.some((item) => item.code === 'OVERTIME_BELOW_MINIMUM' && item.blocking === false));
});

test('desde treinta minutos se reconoce todo el exceso real', () => {
  const cases = [
    { excess: 30, expected: 30 },
    { excess: 45, expected: 45 },
    { excess: 60, expected: 60 }
  ];
  for (const { excess, expected } of cases) {
    const row = reportFor(session({ minutes: 7 * 60 + excess, id: `session-${excess}` }));
    assert.equal(row.ordinaryMinutes, 420);
    assert.equal(row.overtimeMinutes, expected);
    assert.equal(row.unrecognizedOvertimeMinutes, 0);
    assert.equal(row.conceptMinutes.HEDO, expected);
    assert.ok(!row.novelties.some((item) => item.code === 'OVERTIME_BELOW_MINIMUM'));
  }
});

test('el umbral se aplica a una sola jornada aunque cruce medianoche', () => {
  const row = reportFor(
    session({ minutes: 8 * 60, arrivalAt: '2026-07-29T02:00:00.000Z', id: 'overnight-21-to-05' }),
    { from: '2026-07-28', to: '2026-07-29' }
  );
  assert.equal(row.ordinaryMinutes, 420);
  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.unrecognizedOvertimeMinutes, 0);
  assert.equal(row.conceptMinutes.RNO, 420);
  assert.equal(row.conceptMinutes.HENO, 60);
});
