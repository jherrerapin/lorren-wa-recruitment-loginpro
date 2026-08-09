import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculatePayrollConceptReport } from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function overnightSession({
  id = 'TEST-SESSION-OVERNIGHT',
  arrivalReportedAt = '2026-07-29T02:00:00.000Z',
  departureReportedAt = '2026-07-29T10:00:00.000Z',
  expectedStartAt = arrivalReportedAt,
  expectedEndAt = departureReportedAt,
  workedMinutes = 480,
  marks = []
} = {}) {
  return {
    id,
    arrivalReportedAt: new Date(arrivalReportedAt),
    departureReportedAt: new Date(departureReportedAt),
    expectedStartAt: new Date(expectedStartAt),
    expectedEndAt: new Date(expectedEndAt),
    workedMinutes,
    validationStatus: 'MANUAL_VALIDATED',
    marks,
    assignment: {
      workerId: 'TEST-WORKER-OVERNIGHT',
      worker: {
        id: 'TEST-WORKER-OVERNIGHT',
        fullName: 'Auxiliar de prueba',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-OVERNIGHT',
        phone: 'TEST-PHONE-OVERNIGHT'
      },
      serviceRequest: {
        clientName: 'Cliente de prueba',
        operationPointName: 'Operación de prueba',
        operationPoint: {
          id: 'TEST-POINT-OVERNIGHT',
          clientId: 'TEST-CLIENT-OVERNIGHT',
          name: 'Operación de prueba',
          client: { id: 'TEST-CLIENT-OVERNIGHT', name: 'Cliente de prueba' }
        }
      }
    }
  };
}

function calculate(session, range) {
  return calculatePayrollConceptReport({
    sessions: [session],
    policiesByClientId: new Map(),
    compensationByWorkerDate: new Map(),
    range
  });
}

test('turno nocturno 21:00 a 05:00 se agrupa una sola vez por la fecha de entrada', () => {
  const report = calculate(overnightSession(), { from: '2026-07-28', to: '2026-07-28' });

  assert.equal(report.rows.length, 1);
  const row = report.rows[0];
  assert.equal(row.totalMinutes, 480);
  assert.equal(row.ordinaryMinutes, 420);
  assert.equal(row.overtimeMinutes, 60);
  assert.equal(row.conceptMinutes.RNO, 420);
  assert.equal(row.conceptMinutes.HENO, 60);
  assert.equal(row.conceptMinutes.HEDO, 0);

  assert.equal(row.daily.length, 1);
  assert.equal(row.daily[0].dateKey, '2026-07-28');
  assert.equal(row.daily[0].totalMinutes, 480);
  assert.equal(row.daily[0].ordinaryMinutes, 420);
  assert.equal(row.daily[0].overtimeMinutes, 60);
  assert.deepEqual(row.daily[0].civilDateKeys, ['2026-07-28', '2026-07-29']);
});

test('turno 31 de julio 21:00 a 1 de agosto 05:00 con una hora de almuerzo suma siete horas en una sola jornada', () => {
  const session = overnightSession({
    id: 'TEST-SESSION-JUL31-AUG1',
    arrivalReportedAt: '2026-08-01T02:00:00.000Z',
    departureReportedAt: '2026-08-01T10:00:00.000Z',
    expectedStartAt: '2026-08-01T02:00:00.000Z',
    expectedEndAt: '2026-08-01T10:00:00.000Z',
    workedMinutes: 420,
    marks: [
      {
        id: 'TEST-MARK-BREAK-START',
        markType: 'BREAK_START',
        clientCapturedAt: new Date('2026-08-01T06:00:00.000Z'),
        serverReceivedAt: new Date('2026-08-01T06:00:00.000Z')
      },
      {
        id: 'TEST-MARK-BREAK-END',
        markType: 'BREAK_END',
        clientCapturedAt: new Date('2026-08-01T07:00:00.000Z'),
        serverReceivedAt: new Date('2026-08-01T07:00:00.000Z')
      }
    ]
  });

  const report = calculate(session, { from: '2026-07-31', to: '2026-07-31' });
  assert.equal(report.rows.length, 1);
  const row = report.rows[0];
  assert.equal(row.totalMinutes, 420);
  assert.equal(row.ordinaryMinutes, 420);
  assert.equal(row.overtimeMinutes, 0);
  assert.equal(row.conceptMinutes.RNO, 420);
  assert.equal(row.conceptMinutes.HENO, 0);
  assert.equal(row.daily.length, 1);
  assert.equal(row.daily[0].dateKey, '2026-07-31');
  assert.equal(row.daily[0].totalMinutes, 420);
  assert.deepEqual(row.daily[0].civilDateKeys, ['2026-07-31', '2026-08-01']);
});

test('la política de nómina no muestra bloques explicativos de semana ni de festivo', async () => {
  const template = await readFile('src/views/operacionesNomina.ejs', 'utf8');
  assert.doesNotMatch(template, /El acumulado semanal ya no es configurable desde domingo/);
  assert.doesNotMatch(template, /Indicativo Festivo/);
  assert.doesNotMatch(template, /El festivo conserva su concepto y no abre compensatorio/);
});
