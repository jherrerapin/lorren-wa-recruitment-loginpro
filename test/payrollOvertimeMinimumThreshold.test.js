import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MIN_OVERTIME_RECOGNITION_MINUTES,
  PAYROLL_COMPENSATION_STATUS,
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
        documentNumber: 'TEST-DOC-1',
        phone: 'TEST-PHONE-1'
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

function reportFor(sessionValue, range, compensationByWorkerDate = new Map()) {
  return calculatePayrollConceptReport({
    sessions: [sessionValue],
    policiesByClientId: new Map(),
    compensationByWorkerDate,
    range
  }).rows[0];
}

const overtimeCases = [
  { code: 'HEDO', arrivalAt: '2026-07-27T13:00:00.000Z', range: { from: '2026-07-27', to: '2026-07-27' } },
  { code: 'HENO', arrivalAt: '2026-07-27T17:00:00.000Z', range: { from: '2026-07-27', to: '2026-07-27' } },
  { code: 'HEDD', arrivalAt: '2026-08-02T13:00:00.000Z', range: { from: '2026-08-02', to: '2026-08-02' } },
  { code: 'HEND', arrivalAt: '2026-08-02T17:00:00.000Z', range: { from: '2026-08-02', to: '2026-08-02' } },
  { code: 'HEDF', arrivalAt: '2026-07-20T13:00:00.000Z', range: { from: '2026-07-20', to: '2026-07-20' } },
  { code: 'HENF', arrivalAt: '2026-07-20T17:00:00.000Z', range: { from: '2026-07-20', to: '2026-07-20' } }
];

test('las horas extra conservan un mínimo de 30 minutos', () => {
  assert.equal(MIN_OVERTIME_RECOGNITION_MINUTES, 30);
});

test('29 minutos de exceso no se suman a ninguno de los seis conceptos de hora extra', () => {
  for (const item of overtimeCases) {
    const row = reportFor(session({
      minutes: 7 * 60 + 29,
      arrivalAt: item.arrivalAt,
      id: `under-threshold-${item.code}`
    }), item.range);
    assert.equal(row.ordinaryMinutes, 420, item.code);
    assert.equal(row.overtimeMinutes, 0, item.code);
    assert.equal(row.unrecognizedOvertimeMinutes, 29, item.code);
    assert.equal(row.conceptMinutes[item.code], 0, item.code);
    assert.ok(row.novelties.some((novelty) => novelty.code === 'OVERTIME_BELOW_MINIMUM'), item.code);
  }
});

test('exactamente 30 minutos de exceso sí se reconocen en cada concepto de hora extra', () => {
  for (const item of overtimeCases) {
    const row = reportFor(session({
      minutes: 7 * 60 + 30,
      arrivalAt: item.arrivalAt,
      id: `at-threshold-${item.code}`
    }), item.range);
    assert.equal(row.ordinaryMinutes, 420, item.code);
    assert.equal(row.overtimeMinutes, 30, item.code);
    assert.equal(row.unrecognizedOvertimeMinutes, 0, item.code);
    assert.equal(row.conceptMinutes[item.code], 30, item.code);
    assert.ok(!row.novelties.some((novelty) => novelty.code === 'OVERTIME_BELOW_MINIMUM'), item.code);
  }
});

test('un solo minuto de cualquiera de los siete recargos se suma sin umbral mínimo', () => {
  const sundayNotCompensated = new Map([
    ['worker-test|2026-08-02', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]
  ]);
  const sundayCompensated = new Map([
    ['worker-test|2026-08-02', PAYROLL_COMPENSATION_STATUS.COMPENSATED]
  ]);
  const cases = [
    { code: 'RNO', arrivalAt: '2026-07-28T00:00:00.000Z', range: { from: '2026-07-27', to: '2026-07-27' }, compensation: new Map() },
    { code: 'RDD', arrivalAt: '2026-08-02T15:00:00.000Z', range: { from: '2026-08-02', to: '2026-08-02' }, compensation: sundayNotCompensated },
    { code: 'RND', arrivalAt: '2026-08-03T00:00:00.000Z', range: { from: '2026-08-02', to: '2026-08-02' }, compensation: sundayNotCompensated },
    { code: 'RDF', arrivalAt: '2026-07-20T15:00:00.000Z', range: { from: '2026-07-20', to: '2026-07-20' }, compensation: new Map() },
    { code: 'RNF', arrivalAt: '2026-07-21T00:00:00.000Z', range: { from: '2026-07-20', to: '2026-07-20' }, compensation: new Map() },
    { code: 'RDDC', arrivalAt: '2026-08-02T15:00:00.000Z', range: { from: '2026-08-02', to: '2026-08-02' }, compensation: sundayCompensated },
    { code: 'RNDC', arrivalAt: '2026-08-03T00:00:00.000Z', range: { from: '2026-08-02', to: '2026-08-02' }, compensation: sundayCompensated }
  ];

  for (const item of cases) {
    const row = reportFor(session({ minutes: 1, arrivalAt: item.arrivalAt, id: `recargo-${item.code}` }), item.range, item.compensation);
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
