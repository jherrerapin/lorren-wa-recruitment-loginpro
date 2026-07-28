import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYROLL_COMPENSATION_STATUS,
  calculatePayrollConceptReport,
  minutesToDecimalHours
} from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function session({
  id,
  workerId = 'worker-1',
  clientId = 'client-1',
  pointId = 'point-1',
  arrivalAt,
  departureAt,
  expectedStartAt = arrivalAt,
  workedMinutes = null,
  marks = []
}) {
  return {
    id,
    arrivalReportedAt: new Date(arrivalAt),
    departureReportedAt: new Date(departureAt),
    expectedStartAt: new Date(expectedStartAt),
    expectedEndAt: new Date(departureAt),
    workedMinutes,
    validationStatus: 'MANUAL_VALIDATED',
    marks,
    assignment: {
      workerId,
      worker: {
        id: workerId,
        fullName: 'Auxiliar Prueba',
        documentType: 'CC',
        documentNumber: '100000001',
        phone: '3000000000'
      },
      serviceRequest: {
        clientName: 'Cliente Prueba',
        operationPointName: 'Operación Prueba',
        operationPoint: {
          id: pointId,
          clientId,
          name: 'Operación Prueba',
          client: { id: clientId, name: 'Cliente Prueba' }
        }
      }
    }
  };
}

function report(sessions, options = {}) {
  return calculatePayrollConceptReport({
    sessions,
    range: options.range || { from: '2026-07-27', to: '2026-08-02' },
    policiesByClientId: options.policiesByClientId || new Map(),
    compensationByWorkerDate: options.compensationByWorkerDate || new Map()
  });
}

test('conserva minutos y convierte 7 h 30 min en 7.5 horas', () => {
  const result = report([
    session({
      id: 'session-1',
      arrivalAt: '2026-07-27T13:00:00.000Z',
      departureAt: '2026-07-27T20:30:00.000Z',
      workedMinutes: 450
    })
  ]);

  assert.equal(result.rows[0].totalMinutes, 450);
  assert.equal(result.rows[0].ordinaryMinutes, 420);
  assert.equal(result.rows[0].overtimeMinutes, 30);
  assert.equal(result.rows[0].conceptMinutes.HEDO, 30);
  assert.equal(result.rows[0].totalHours, 7.5);
  assert.equal(minutesToDecimalHours(455), 7.5833);
});

test('separa recargo nocturno ordinario desde las 7 p. m.', () => {
  const result = report([
    session({
      id: 'session-night',
      arrivalAt: '2026-07-27T23:00:00.000Z',
      departureAt: '2026-07-28T01:00:00.000Z',
      workedMinutes: 120
    })
  ]);

  assert.equal(result.rows[0].ordinaryMinutes, 120);
  assert.equal(result.rows[0].conceptMinutes.RNO, 60);
  assert.equal(result.rows[0].conceptMinutes.HENO, 0);
});

test('clasifica domingo ordinario como no compensado o compensado', () => {
  const sundaySession = session({
    id: 'session-sunday',
    arrivalAt: '2026-08-02T13:00:00.000Z',
    departureAt: '2026-08-02T15:00:00.000Z',
    workedMinutes: 120
  });

  const pending = report([sundaySession]);
  assert.equal(pending.rows[0].conceptMinutes.RDD, 120);
  assert.equal(pending.rows[0].exportable, false);
  assert.ok(pending.rows[0].novelties.some((item) => item.code === 'COMPENSATION_PENDING'));

  const compensated = report([sundaySession], {
    compensationByWorkerDate: new Map([
      ['worker-1|2026-08-02', PAYROLL_COMPENSATION_STATUS.COMPENSATED]
    ])
  });
  assert.equal(compensated.rows[0].conceptMinutes.RDD, 0);
  assert.equal(compensated.rows[0].conceptMinutes.RDDC, 120);
  assert.ok(!compensated.rows[0].novelties.some((item) => item.code === 'COMPENSATION_PENDING'));
});

test('calcula el límite ordinario semanal antes de clasificar el domingo', () => {
  const sessions = [];
  for (let day = 27; day <= 31; day += 1) {
    sessions.push(session({
      id: `session-july-${day}`,
      arrivalAt: `2026-07-${day}T13:00:00.000Z`,
      departureAt: `2026-07-${day}T20:00:00.000Z`,
      workedMinutes: 420
    }));
  }
  sessions.push(session({
    id: 'session-saturday',
    arrivalAt: '2026-08-01T13:00:00.000Z',
    departureAt: '2026-08-01T20:00:00.000Z',
    workedMinutes: 420
  }));
  sessions.push(session({
    id: 'session-sunday-extra',
    arrivalAt: '2026-08-02T13:00:00.000Z',
    departureAt: '2026-08-02T14:00:00.000Z',
    workedMinutes: 60
  }));

  const result = report(sessions, {
    compensationByWorkerDate: new Map([
      ['worker-1|2026-08-02', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]
    ])
  });

  assert.equal(result.rows[0].ordinaryMinutes, 42 * 60);
  assert.equal(result.rows[0].overtimeMinutes, 60);
  assert.equal(result.rows[0].conceptMinutes.HEDD, 60);
});

test('una quincena puede recibir jornadas previas para conservar el acumulado semanal', () => {
  const policiesByClientId = new Map([[
    'client-1',
    {
      weeklyOrdinaryMinutes: 120,
      dailyOrdinaryMinutes: 600,
      maxDailyOvertimeMinutes: 600,
      maxWeeklyOvertimeMinutes: 600,
      nightStartMinute: 1140,
      nightEndMinute: 360,
      weekStartsOn: 1,
      restDay: 0
    }
  ]]);
  const result = report([
    session({ id: 'before-period', arrivalAt: '2026-07-13T13:00:00.000Z', departureAt: '2026-07-13T15:00:00.000Z', workedMinutes: 120 }),
    session({ id: 'inside-period', arrivalAt: '2026-07-16T13:00:00.000Z', departureAt: '2026-07-16T14:00:00.000Z', workedMinutes: 60 })
  ], {
    range: { from: '2026-07-16', to: '2026-07-31' },
    policiesByClientId
  });

  assert.equal(result.rows[0].totalMinutes, 60);
  assert.equal(result.rows[0].ordinaryMinutes, 0);
  assert.equal(result.rows[0].conceptMinutes.HEDO, 60);
});
