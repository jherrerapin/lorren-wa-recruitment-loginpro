import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYROLL_COMPENSATION_STATUS,
  calculatePayrollConceptReport,
  minutesToDecimalHours,
  normalizePayrollPolicy
} from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function bogotaDateTime(dateKey, hour, minute = 0) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

function session({
  id,
  dateKey,
  startHour = 8,
  startMinute = 0,
  minutes,
  workerId = 'TEST-WORKER-1',
  clientId = 'TEST-CLIENT-1',
  marks = []
}) {
  const arrivalAt = bogotaDateTime(dateKey, startHour, startMinute);
  const departureAt = new Date(arrivalAt.getTime() + minutes * 60_000);
  return {
    id,
    arrivalReportedAt: arrivalAt,
    departureReportedAt: departureAt,
    expectedStartAt: arrivalAt,
    expectedEndAt: departureAt,
    workedMinutes: minutes,
    validationStatus: 'MANUAL_VALIDATED',
    marks,
    assignment: {
      workerId,
      worker: {
        id: workerId,
        fullName: 'TEST Auxiliar',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-1',
        phone: 'TEST-PHONE-1'
      },
      serviceRequest: {
        clientName: 'TEST Cliente',
        operationPointName: 'TEST Operación',
        operationPoint: {
          id: 'TEST-POINT-1',
          clientId,
          name: 'TEST Operación',
          client: { id: clientId, name: 'TEST Cliente' }
        }
      }
    }
  };
}

function report(sessions, options = {}) {
  return calculatePayrollConceptReport({
    sessions,
    range: options.range || { from: '2026-08-03', to: '2026-08-09' },
    policiesByClientId: options.policiesByClientId || new Map(),
    compensationByWorkerDate: options.compensationByWorkerDate || new Map()
  });
}

test('un remanente exacto de 30 minutos no se reconoce como hora extra', () => {
  const row = report([
    session({ id: 'TEST-THRESHOLD-30', dateKey: '2026-08-03', minutes: 450 })
  ]).rows[0];

  assert.equal(row.totalMinutes, 450);
  assert.equal(row.overtimeMinutes, 0);
  assert.equal(row.conceptMinutes.HEDO, 0);
  assert.equal(row.totalHours, 7.5);
  assert.equal(minutesToDecimalHours(455), 7.6);
});

test('separa el recargo nocturno ordinario desde las 7 p. m. sin exigir hora extra', () => {
  const row = report([
    session({ id: 'TEST-NIGHT', dateKey: '2026-08-03', startHour: 18, minutes: 120 })
  ]).rows[0];

  assert.equal(row.overtimeMinutes, 0);
  assert.equal(row.conceptMinutes.RNO, 60);
  assert.equal(row.conceptMinutes.HENO, 0);
});

test('clasifica domingo ordinario como no compensado o compensado', () => {
  const sunday = session({ id: 'TEST-SUNDAY', dateKey: '2026-08-09', minutes: 120 });

  const pending = report([sunday], {
    compensationByWorkerDate: new Map([
      ['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]
    ])
  });
  assert.equal(pending.rows[0].conceptMinutes.RDD, 120);

  const compensated = report([sunday], {
    compensationByWorkerDate: new Map([
      ['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.COMPENSATED]
    ])
  });
  assert.equal(compensated.rows[0].conceptMinutes.RDD, 0);
  assert.equal(compensated.rows[0].conceptMinutes.RDDC, 120);
});

test('una jornada aislada de ocho horas deja una hora extra sin depender de 42 horas semanales', () => {
  const row = report([
    session({ id: 'TEST-ISOLATED-8H', dateKey: '2026-08-03', minutes: 8 * 60 })
  ]).rows[0];

  assert.equal(row.totalMinutes, 8 * 60);
  assert.equal(row.ordinaryMinutes, 7 * 60);
  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.conceptMinutes.HEDO, 60);
});

test('10 h + 6 h + 6 h usa dos horas del exceso para cubrir los faltantes y deja una hora extra', () => {
  const row = report([
    session({ id: 'TEST-BALANCE-10', dateKey: '2026-08-03', minutes: 10 * 60 }),
    session({ id: 'TEST-BALANCE-6A', dateKey: '2026-08-04', minutes: 6 * 60 }),
    session({ id: 'TEST-BALANCE-6B', dateKey: '2026-08-05', minutes: 6 * 60 })
  ]).rows[0];

  assert.equal(row.totalMinutes, 22 * 60);
  assert.equal(row.ordinaryMinutes, 21 * 60);
  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.conceptMinutes.HEDO, 60);
});

test('10 h + 6 h + 6 h + 6 h consume por completo las tres horas candidatas', () => {
  const row = report([
    session({ id: 'TEST-ZERO-10', dateKey: '2026-08-03', minutes: 10 * 60 }),
    session({ id: 'TEST-ZERO-6A', dateKey: '2026-08-04', minutes: 6 * 60 }),
    session({ id: 'TEST-ZERO-6B', dateKey: '2026-08-05', minutes: 6 * 60 }),
    session({ id: 'TEST-ZERO-6C', dateKey: '2026-08-06', minutes: 6 * 60 })
  ]).rows[0];

  assert.equal(row.totalMinutes, 28 * 60);
  assert.equal(row.overtimeMinutes, 0);
  assert.equal(row.conceptMinutes.HEDO, 0);
});

test('un remanente de veinte minutos después del balance no se reconoce como hora extra', () => {
  const row = report([
    session({ id: 'TEST-SMALL-10', dateKey: '2026-08-03', minutes: 10 * 60 }),
    session({ id: 'TEST-SMALL-6A', dateKey: '2026-08-04', minutes: 6 * 60 }),
    session({ id: 'TEST-SMALL-6B', dateKey: '2026-08-05', minutes: 6 * 60 }),
    session({ id: 'TEST-SMALL-620', dateKey: '2026-08-06', minutes: (6 * 60) + 20 })
  ]).rows[0];

  assert.equal(row.overtimeMinutes, 0);
  assert.equal(row.conceptMinutes.HEDO, 0);
  assert.ok(row.novelties.some((novelty) => novelty.code === 'OVERTIME_BELOW_MINIMUM'));
});

test('los faltantes consumen HEDO antes que HENO y el HENO retirado conserva RNO', () => {
  const row = report([
    session({ id: 'TEST-ORDER-LONG', dateKey: '2026-08-03', startHour: 11, minutes: 9.5 * 60 }),
    session({ id: 'TEST-ORDER-SHORT', dateKey: '2026-08-04', minutes: 5.5 * 60 })
  ]).rows[0];

  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.conceptMinutes.HEDO, 0, 'la primera hora retirada debe ser HEDO');
  assert.equal(row.conceptMinutes.HENO, 60, 'queda una hora nocturna como remanente extra');
  assert.equal(row.conceptMinutes.RNO, 30, 'los 30 minutos HENO retirados vuelven a ordinario con RNO');
});

test('la compensación completa recorre HEDO, HENO, HEDD, HEND, HEDF y deja HENF al final', () => {
  const row = report([
    session({ id: 'TEST-ORDER-WEEKDAY', dateKey: '2026-08-03', startHour: 11, minutes: 9 * 60 }),
    session({ id: 'TEST-ORDER-SHORT-TUE', dateKey: '2026-08-04', minutes: 5 * 60 }),
    session({ id: 'TEST-ORDER-SHORT-WED', dateKey: '2026-08-05', minutes: 5.5 * 60 }),
    session({ id: 'TEST-ORDER-SHORT-THU', dateKey: '2026-08-06', minutes: 5.5 * 60 }),
    session({ id: 'TEST-ORDER-HOLIDAY', dateKey: '2026-08-07', startHour: 11, minutes: 9 * 60 }),
    session({ id: 'TEST-ORDER-SAT', dateKey: '2026-08-08', minutes: 7 * 60 }),
    session({ id: 'TEST-ORDER-SUNDAY', dateKey: '2026-08-09', startHour: 11, minutes: 9 * 60 })
  ], {
    compensationByWorkerDate: new Map([
      ['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]
    ])
  }).rows[0];

  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.conceptMinutes.HEDO, 0);
  assert.equal(row.conceptMinutes.HENO, 0);
  assert.equal(row.conceptMinutes.HEDD, 0);
  assert.equal(row.conceptMinutes.HEND, 0);
  assert.equal(row.conceptMinutes.HEDF, 0);
  assert.equal(row.conceptMinutes.HENF, 60, 'solo queda HENF después de consumir 300 minutos en el orden canónico');
  assert.equal(row.conceptMinutes.RNO, 60, 'HENO retirada conserva RNO');
  assert.equal(row.conceptMinutes.RDD, 8 * 60, 'HEDD retirada vuelve al recargo dominical diurno');
  assert.equal(row.conceptMinutes.RND, 60, 'HEND retirada vuelve al recargo dominical nocturno');
  assert.equal(row.conceptMinutes.RDF, 8 * 60, 'HEDF retirada vuelve al recargo festivo diurno');
  assert.equal(row.conceptMinutes.RNF, 0, 'HENF queda como extra y no se duplica como recargo');
});

test('el valor histórico de 42 h queda como compatibilidad y no decide las horas extra', () => {
  const historical = normalizePayrollPolicy({ weeklyOrdinaryMinutes: 120, dailyOrdinaryMinutes: 60 });
  assert.equal(historical.weeklyOrdinaryMinutes, 42 * 60);
  assert.equal(historical.dailyOrdinaryMinutes, 7 * 60);

  const row = report([
    session({ id: 'TEST-HISTORICAL-8H', dateKey: '2026-08-03', minutes: 8 * 60 })
  ], {
    policiesByClientId: new Map([['TEST-CLIENT-1', { weeklyOrdinaryMinutes: 120, dailyOrdinaryMinutes: 60 }]])
  }).rows[0];

  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.conceptMinutes.HEDO, 60);
});

test('el almuerzo se descuenta una sola vez y modifica el exceso diario real', () => {
  const breakMarks = (endMinute) => [
    {
      markType: 'BREAK_START',
      clientCapturedAt: bogotaDateTime('2026-08-03', 12, 0),
      serverReceivedAt: bogotaDateTime('2026-08-03', 12, 0)
    },
    {
      markType: 'BREAK_END',
      clientCapturedAt: bogotaDateTime('2026-08-03', 13, endMinute),
      serverReceivedAt: bogotaDateTime('2026-08-03', 13, endMinute)
    }
  ];

  const oneHour = report([
    session({ id: 'TEST-LUNCH-60', dateKey: '2026-08-03', minutes: 10 * 60, marks: breakMarks(0) })
  ]).rows[0];
  const ninety = report([
    session({ id: 'TEST-LUNCH-90', dateKey: '2026-08-03', minutes: 10 * 60, marks: breakMarks(30) })
  ]).rows[0];

  assert.equal(oneHour.totalMinutes, 9 * 60);
  assert.equal(oneHour.overtimeMinutes, 2 * 60);
  assert.equal(ninety.totalMinutes, (8 * 60) + 30);
  assert.equal(ninety.overtimeMinutes, 90);
});
