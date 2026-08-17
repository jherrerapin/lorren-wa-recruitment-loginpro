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

function sevenHours(dateKey, id = `TEST-${dateKey}`) {
  return session({ id, dateKey, minutes: 7 * 60 });
}

function weekBaseThroughSaturday() {
  return ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08']
    .map((dateKey) => sevenHours(dateKey));
}

test('7 h es referencia flexible: una jornada aislada de 7 h 30 min no genera extra', () => {
  const result = report([
    session({ id: 'TEST-FLEX-450', dateKey: '2026-08-03', minutes: 450 })
  ]);

  const row = result.rows[0];
  assert.equal(row.totalMinutes, 450);
  assert.equal(row.ordinaryMinutes, 450);
  assert.equal(row.overtimeMinutes, 0);
  assert.equal(row.conceptMinutes.HEDO, 0);
  assert.equal(row.totalHours, 7.5);
  assert.equal(minutesToDecimalHours(455), 7.6);
});

test('separa el recargo nocturno ordinario desde las 7 p. m. sin exigir hora extra', () => {
  const result = report([
    session({ id: 'TEST-NIGHT', dateKey: '2026-08-03', startHour: 18, minutes: 120 })
  ]);

  const row = result.rows[0];
  assert.equal(row.ordinaryMinutes, 120);
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

test('solo el exceso semanal sobre 42 h se convierte en hora extra aunque el último día sea corto', () => {
  const sessions = [
    ...weekBaseThroughSaturday(),
    session({ id: 'TEST-SUNDAY-EXTRA', dateKey: '2026-08-09', minutes: 60 })
  ];
  const result = report(sessions, {
    compensationByWorkerDate: new Map([
      ['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]
    ])
  });

  const row = result.rows[0];
  assert.equal(row.ordinaryMinutes, 42 * 60);
  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.conceptMinutes.HEDD, 60);
  assert.equal(row.conceptMinutes.RDD, 0);
});

test('los faltantes diarios compensan horas extra de izquierda a derecha HEDO y luego HENO', () => {
  const sessions = [
    session({ id: 'TEST-MONDAY-LONG', dateKey: '2026-08-03', startHour: 11, minutes: 9 * 60 }),
    session({ id: 'TEST-TUESDAY-SHORT', dateKey: '2026-08-04', minutes: 5.5 * 60 }),
    sevenHours('2026-08-05'),
    sevenHours('2026-08-06'),
    sevenHours('2026-08-07'),
    sevenHours('2026-08-08')
  ];
  const result = report(sessions);
  const row = result.rows[0];

  assert.equal(row.totalMinutes, (42 * 60) + 30);
  assert.equal(row.overtimeMinutes, 30);
  assert.equal(row.conceptMinutes.HEDO, 0, 'el faltante consume primero HEDO');
  assert.equal(row.conceptMinutes.HENO, 30, 'solo queda el remanente nocturno');
  assert.equal(row.conceptMinutes.RNO, 30, 'el HENO compensado vuelve a ordinario pero conserva RNO');
});

test('el motor fija 42 h semanales y 7 h como referencia aunque una política histórica diga otra cosa', () => {
  const historical = normalizePayrollPolicy({ weeklyOrdinaryMinutes: 120, dailyOrdinaryMinutes: 60 });
  assert.equal(historical.weeklyOrdinaryMinutes, 42 * 60);
  assert.equal(historical.dailyOrdinaryMinutes, 7 * 60);

  const sessions = [
    session({ id: 'TEST-MONDAY-9H', dateKey: '2026-08-03', minutes: 9 * 60 }),
    session({ id: 'TEST-TUESDAY-5H', dateKey: '2026-08-04', minutes: 5 * 60 }),
    sevenHours('2026-08-05'),
    sevenHours('2026-08-06'),
    sevenHours('2026-08-07'),
    sevenHours('2026-08-08')
  ];
  const result = report(sessions, {
    range: { from: '2026-08-03', to: '2026-08-05' },
    policiesByClientId: new Map([['TEST-CLIENT-1', { weeklyOrdinaryMinutes: 120, dailyOrdinaryMinutes: 60 }]])
  });

  const row = result.rows[0];
  assert.equal(row.totalMinutes, 21 * 60, 'solo muestra el rango solicitado');
  assert.equal(row.overtimeMinutes, 0, 'la semana completa suma 42 h y neutraliza el exceso del lunes');
  assert.equal(row.conceptMinutes.HEDO, 0);
});

test('el almuerzo superior a una hora reduce el exceso semanal sin tocar recargos', () => {
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
  const remainder = [
    sevenHours('2026-08-04'),
    sevenHours('2026-08-05'),
    sevenHours('2026-08-06'),
    sevenHours('2026-08-07'),
    sevenHours('2026-08-08')
  ];
  const mondayOneHour = session({ id: 'TEST-LUNCH-60', dateKey: '2026-08-03', minutes: 10 * 60, marks: breakMarks(0) });
  const mondayNinety = session({ id: 'TEST-LUNCH-90', dateKey: '2026-08-03', minutes: 10 * 60, marks: breakMarks(30) });

  const oneHour = report([mondayOneHour, ...remainder]).rows[0];
  const ninety = report([mondayNinety, ...remainder]).rows[0];
  assert.equal(oneHour.totalMinutes, 44 * 60);
  assert.equal(oneHour.overtimeMinutes, 2 * 60);
  assert.equal(ninety.totalMinutes, (43 * 60) + 30);
  assert.equal(ninety.overtimeMinutes, 90);
});
