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

const overtimeCases = [
  { code: 'HEDO', dateKey: '2026-08-03', startHour: 8, shortDate: '2026-08-04' },
  { code: 'HENO', dateKey: '2026-08-03', startHour: 12, shortDate: '2026-08-04' },
  { code: 'HEDD', dateKey: '2026-08-09', startHour: 8, shortDate: '2026-08-03' },
  { code: 'HEND', dateKey: '2026-08-09', startHour: 12, shortDate: '2026-08-03' },
  { code: 'HEDF', dateKey: '2026-08-07', startHour: 8, shortDate: '2026-08-03' },
  { code: 'HENF', dateKey: '2026-08-07', startHour: 12, shortDate: '2026-08-03' }
];

function balancedRemainderScenario(item, remainingMinutes) {
  const compensation = item.code === 'HEDD' || item.code === 'HEND'
    ? new Map([['TEST-WORKER-THRESHOLD|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]])
    : new Map();
  return calculate([
    session({
      id: `TEST-TARGET-${item.code}-${remainingMinutes}`,
      dateKey: item.dateKey,
      startHour: item.startHour,
      minutes: (8 * 60) + remainingMinutes
    }),
    session({
      id: `TEST-SHORT-${item.code}-${remainingMinutes}`,
      dateKey: item.shortDate,
      minutes: 6 * 60
    })
  ], compensation);
}

test('el umbral de referencia se conserva en treinta minutos pero debe superarse', () => {
  assert.equal(MIN_OVERTIME_RECOGNITION_MINUTES, 30);
});

test('exactamente treinta minutos después de cubrir una hora faltante no reconoce ninguno de los seis H*', () => {
  for (const item of overtimeCases) {
    const row = balancedRemainderScenario(item, 30);
    assert.equal(row.overtimeMinutes, 0, item.code);
    assert.equal(row.unrecognizedOvertimeMinutes, 30, item.code);
    assert.equal(row.conceptMinutes[item.code], 0, item.code);
    assert.ok(row.novelties.some((novelty) => novelty.code === 'OVERTIME_BELOW_MINIMUM'), item.code);
  }
});

test('treinta y un minutos después de cubrir una hora faltante sí se reconocen en cada concepto H*', () => {
  for (const item of overtimeCases) {
    const row = balancedRemainderScenario(item, 31);
    assert.equal(row.overtimeMinutes, 31, item.code);
    assert.equal(row.unrecognizedOvertimeMinutes, 0, item.code);
    assert.equal(row.conceptMinutes[item.code], 31, item.code);
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
