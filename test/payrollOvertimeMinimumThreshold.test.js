import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MIN_OVERTIME_RECOGNITION_MINUTES,
  PAYROLL_COMPENSATION_STATUS,
  calculatePayrollConceptReport
} from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function bogotaDateTime(dateKey, hour, minute = 0) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

function session({ id, dateKey, startHour = 8, minutes }) {
  const arrival = bogotaDateTime(dateKey, startHour);
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
      workerId: 'TEST-WORKER-THRESHOLD',
      worker: {
        id: 'TEST-WORKER-THRESHOLD',
        fullName: 'TEST Auxiliar umbral',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-THRESHOLD',
        phone: 'TEST-PHONE-THRESHOLD'
      },
      serviceRequest: {
        clientName: 'TEST Cliente',
        operationPointName: 'TEST Operación',
        operationPoint: {
          id: 'TEST-POINT-THRESHOLD',
          clientId: 'TEST-CLIENT-THRESHOLD',
          name: 'TEST Operación',
          client: { id: 'TEST-CLIENT-THRESHOLD', name: 'TEST Cliente' }
        }
      }
    }
  };
}

function calculate(sessions, compensation = new Map()) {
  return calculatePayrollConceptReport({
    sessions,
    policiesByClientId: new Map(),
    compensationByWorkerDate: compensation,
    range: { from: '2026-08-03', to: '2026-08-09' }
  }).rows[0];
}

const cases = [
  {
    code: 'HEDO', dateKey: '2026-08-03', startHour: 8,
    baseline: ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'],
    fallbackRecargo: null
  },
  {
    code: 'HENO', dateKey: '2026-08-03', startHour: 12,
    baseline: ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'],
    fallbackRecargo: 'RNO'
  },
  {
    code: 'HEDD', dateKey: '2026-08-09', startHour: 8,
    baseline: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'],
    fallbackRecargo: 'RDD'
  },
  {
    code: 'HEND', dateKey: '2026-08-09', startHour: 12,
    baseline: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'],
    fallbackRecargo: 'RND'
  },
  {
    code: 'HEDF', dateKey: '2026-08-07', startHour: 8,
    baseline: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-08'],
    fallbackRecargo: 'RDF'
  },
  {
    code: 'HENF', dateKey: '2026-08-07', startHour: 12,
    baseline: ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-08'],
    fallbackRecargo: 'RNF'
  }
];

function weeklyScenario(item, extraMinutes) {
  const sessions = item.baseline.map((dateKey, index) => session({
    id: `TEST-BASE-${item.code}-${index}`,
    dateKey,
    minutes: 7 * 60
  }));
  sessions.push(session({
    id: `TEST-TARGET-${item.code}-${extraMinutes}`,
    dateKey: item.dateKey,
    startHour: item.startHour,
    minutes: (7 * 60) + extraMinutes
  }));
  const compensation = item.code === 'HEDD' || item.code === 'HEND'
    ? new Map([['TEST-WORKER-THRESHOLD|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]])
    : new Map();
  return calculate(sessions, compensation);
}

test('las horas extra conservan un mínimo de 30 minutos después del balance semanal', () => {
  assert.equal(MIN_OVERTIME_RECOGNITION_MINUTES, 30);
});

test('42 h 29 min no reconoce H* y conserva el recargo ordinario correspondiente', () => {
  for (const item of cases) {
    const row = weeklyScenario(item, 29);
    assert.equal(row.overtimeMinutes, 0, item.code);
    assert.equal(row.unrecognizedOvertimeMinutes, 29, item.code);
    assert.equal(row.conceptMinutes[item.code], 0, item.code);
    if (item.fallbackRecargo) assert.equal(row.conceptMinutes[item.fallbackRecargo], 29, `${item.code} conserva ${item.fallbackRecargo}`);
    assert.ok(row.novelties.some((novelty) => novelty.code === 'OVERTIME_BELOW_MINIMUM'), item.code);
  }
});

test('42 h 30 min reconoce exactamente 30 minutos en cada concepto H*', () => {
  for (const item of cases) {
    const row = weeklyScenario(item, 30);
    assert.equal(row.overtimeMinutes, 30, item.code);
    assert.equal(row.unrecognizedOvertimeMinutes, 0, item.code);
    assert.equal(row.conceptMinutes[item.code], 30, item.code);
    assert.ok(!row.novelties.some((novelty) => novelty.code === 'OVERTIME_BELOW_MINIMUM'), item.code);
  }
});

test('un solo minuto de cualquiera de los siete recargos se suma sin umbral mínimo', () => {
  const sundayNotCompensated = new Map([
    ['TEST-WORKER-THRESHOLD|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]
  ]);
  const sundayCompensated = new Map([
    ['TEST-WORKER-THRESHOLD|2026-08-09', PAYROLL_COMPENSATION_STATUS.COMPENSATED]
  ]);
  const recargoCases = [
    { code: 'RNO', dateKey: '2026-08-03', startHour: 19, compensation: new Map() },
    { code: 'RDD', dateKey: '2026-08-09', startHour: 8, compensation: sundayNotCompensated },
    { code: 'RND', dateKey: '2026-08-09', startHour: 19, compensation: sundayNotCompensated },
    { code: 'RDF', dateKey: '2026-08-07', startHour: 8, compensation: new Map() },
    { code: 'RNF', dateKey: '2026-08-07', startHour: 19, compensation: new Map() },
    { code: 'RDDC', dateKey: '2026-08-09', startHour: 8, compensation: sundayCompensated },
    { code: 'RNDC', dateKey: '2026-08-09', startHour: 19, compensation: sundayCompensated }
  ];

  for (const item of recargoCases) {
    const row = calculate([
      session({ id: `TEST-RECARGO-${item.code}`, dateKey: item.dateKey, startHour: item.startHour, minutes: 1 })
    ], item.compensation);
    assert.equal(row.totalMinutes, 1, item.code);
    assert.equal(row.overtimeMinutes, 0, item.code);
    assert.equal(row.unrecognizedOvertimeMinutes, 0, item.code);
    assert.equal(row.conceptMinutes[item.code], 1, item.code);
  }
});

test('la pantalla oculta Bajo umbral y la fecha de referencia en corte personalizado', async () => {
  const [template, testTemplate] = await Promise.all([
    readFile('src/views/operacionesNomina.ejs', 'utf8'),
    readFile('src/views/operacionesPruebasNomina.ejs', 'utf8')
  ]);
  for (const source of [template, testTemplate]) {
    assert.doesNotMatch(source, /Bajo umbral|Extra bajo umbral/i);
  }
  assert.match(template, /id="anchorDateField"/);
  assert.match(template, /anchorDateField\.style\.display = custom \? 'none' : 'flex'/);
  assert.match(template, /customDates\.forEach\(\(field\) => \{ field\.style\.display = custom \? 'flex' : 'none'; \}\)/);
});
