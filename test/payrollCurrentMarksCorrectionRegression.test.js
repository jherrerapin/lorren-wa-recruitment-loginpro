import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculatePayrollConceptReport } from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';
import { loadPayrollReport } from '../src/modules/dispatch-payroll/application/payrollReport.js';

function sessionFixture(overrides = {}) {
  const arrivalAt = new Date(overrides.arrivalAt || '2026-08-10T13:00:00.000Z');
  const departureAt = new Date(overrides.departureAt || '2026-08-10T21:30:00.000Z');
  const id = overrides.id || 'TEST-SESSION-CURRENT-MARKS';
  return {
    id,
    arrivalReportedAt: arrivalAt,
    departureReportedAt: departureAt,
    expectedStartAt: new Date(overrides.expectedStartAt || arrivalAt),
    expectedEndAt: departureAt,
    workedMinutes: overrides.workedMinutes ?? 450,
    validationStatus: 'MANUAL_VALIDATED',
    marks: [
      { id: `${id}-BS`, markType: 'BREAK_START', clientCapturedAt: new Date('2026-08-10T17:00:00.000Z'), serverReceivedAt: new Date('2026-08-10T17:00:00.000Z') },
      { id: `${id}-BE`, markType: 'BREAK_END', clientCapturedAt: new Date('2026-08-10T18:00:00.000Z'), serverReceivedAt: new Date('2026-08-10T18:00:00.000Z') }
    ],
    reviews: overrides.reviews || [],
    assignment: {
      workerId: 'TEST-WORKER-CURRENT-MARKS',
      worker: { id: 'TEST-WORKER-CURRENT-MARKS', fullName: 'Auxiliar Prueba Marcaciones', isTestProfile: false },
      serviceRequest: {
        source: 'INTERNAL',
        clientName: 'Cliente Prueba',
        operationPointName: 'Operación Prueba',
        operationPoint: { id: 'TEST-POINT', clientId: 'TEST-CLIENT', name: 'Operación Prueba', client: { id: 'TEST-CLIENT', name: 'Cliente Prueba' } }
      }
    }
  };
}

function prismaFixture(sessions) {
  return {
    dispatchAttendanceSession: { async findMany() { return sessions; } },
    dispatchClient: { async findMany() { return []; } },
    dispatchWorker: { async findMany() { return [{ id: 'TEST-WORKER-CURRENT-MARKS', fullName: 'Auxiliar Prueba Marcaciones', isTestProfile: false }]; } },
    devAuditEvent: { async findMany() { return []; } }
  };
}

test('Gestión de Tiempo usa las marcaciones vigentes aunque workedMinutes histórico sea distinto', () => {
  const report = calculatePayrollConceptReport({
    sessions: [sessionFixture({ workedMinutes: 420 })],
    range: { from: '2026-08-10', to: '2026-08-10' }
  });
  const row = report.rows[0];
  assert.equal(row.totalMinutes, 450);
  assert.equal(row.totalHours, 7.5);
  assert.equal(row.ordinaryHours, 7);
  assert.equal(row.overtimeHours, 0.5);
  assert.equal(row.exportable, true);
  assert.equal(row.novelties.some((item) => item.code === 'WORKED_MINUTES_MISMATCH'), false);
});

test('la corrección manual conserva su justificación como observación del detalle', async () => {
  const reason = 'Ajuste solicitado por coordinación durante la revisión de la jornada.';
  const session = sessionFixture({
    arrivalAt: '2026-08-10T13:15:00.000Z',
    expectedStartAt: '2026-08-10T13:00:00.000Z',
    workedMinutes: 435,
    reviews: [{
      action: 'WORKDAY_EDIT_MARK',
      reason,
      metadata: {
        markId: 'TEST-MARK-ARRIVAL',
        markType: 'ARRIVAL',
        previousCapturedAt: '2026-08-10T13:00:00.000Z',
        newCapturedAt: '2026-08-10T13:15:00.000Z'
      }
    }]
  });
  const report = await loadPayrollReport(
    prismaFixture([session]),
    { periodType: 'CUSTOM', from: '2026-08-10', to: '2026-08-10' },
    { now: new Date('2026-08-10T23:00:00.000Z') }
  );
  const correction = report.rows[0].daily[0].markings[0].corrections[0];
  assert.equal(correction.markTypeLabel, 'Entrada');
  assert.match(correction.previousLabel, /8:00/);
  assert.match(correction.newLabel, /8:15/);
  assert.equal(correction.reason, reason);
});

test('la interfaz agrupa filtros y usa un desplegable con checks para auxiliares', async () => {
  const [view, detail, engine] = await Promise.all([
    readFile(new URL('../src/views/operacionesGestionTiempo.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/partials/operacionesGestionTiempoTabla.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-payroll/domain/payrollConceptEngine.js', import.meta.url), 'utf8')
  ]);
  assert.match(view, /payroll-filter-stack/);
  assert.match(view, /payroll-filter-row/);
  assert.match(view, /worker-picker/);
  assert.match(view, /type="checkbox" name="workerId"/);
  assert.doesNotMatch(view, /name="workerId" multiple/);
  assert.match(detail, /Observación de coordinación:/);
  assert.match(detail, /correction\.reason/);
  assert.doesNotMatch(engine, /WORKED_MINUTES_MISMATCH/);
  assert.doesNotMatch(engine, /storedWorkedMinutes/);
});
