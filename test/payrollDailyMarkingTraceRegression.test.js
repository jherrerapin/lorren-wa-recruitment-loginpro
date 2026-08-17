import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPayrollExportRows, loadPayrollReport } from '../src/modules/dispatch-payroll/application/payrollReport.js';
import { applyPayrollWorkerSelection } from '../src/routes/dispatchPayroll.js';

function sessionFixture(overrides = {}) {
  const arrivalAt = overrides.arrivalAt || '2026-08-10T13:00:00.000Z';
  const departureAt = overrides.departureAt || '2026-08-10T21:30:00.000Z';
  const breakStartAt = overrides.breakStartAt === undefined ? '2026-08-10T17:00:00.000Z' : overrides.breakStartAt;
  const breakEndAt = overrides.breakEndAt === undefined ? '2026-08-10T18:00:00.000Z' : overrides.breakEndAt;
  const id = overrides.id || 'TEST-SESSION-TRACE';
  const marks = [];
  if (breakStartAt) marks.push({ id: `${id}-BS`, markType: 'BREAK_START', clientCapturedAt: new Date(breakStartAt), serverReceivedAt: new Date(breakStartAt) });
  if (breakEndAt) marks.push({ id: `${id}-BE`, markType: 'BREAK_END', clientCapturedAt: new Date(breakEndAt), serverReceivedAt: new Date(breakEndAt) });
  return {
    id,
    arrivalReportedAt: new Date(arrivalAt),
    departureReportedAt: new Date(departureAt),
    expectedStartAt: new Date(arrivalAt),
    expectedEndAt: new Date(departureAt),
    workedMinutes: overrides.workedMinutes ?? 450,
    validationStatus: 'MANUAL_VALIDATED',
    marks,
    assignment: {
      workerId: 'TEST-WORKER-TRACE',
      worker: { id: 'TEST-WORKER-TRACE', fullName: 'TEST Auxiliar trazabilidad', isTestProfile: false },
      serviceRequest: {
        source: 'INTERNAL', clientName: 'TEST Cliente', operationPointName: 'TEST Operación',
        operationPoint: { id: 'TEST-POINT-TRACE', clientId: 'TEST-CLIENT-TRACE', name: 'TEST Operación', client: { id: 'TEST-CLIENT-TRACE', name: 'TEST Cliente' } }
      }
    }
  };
}

function prismaFixture(sessions) {
  return {
    dispatchAttendanceSession: { async findMany() { return sessions; } },
    dispatchClient: { async findMany() { return []; } },
    dispatchWorker: { async findMany() { return [{ id: 'TEST-WORKER-TRACE', fullName: 'TEST Auxiliar trazabilidad', isTestProfile: false }]; } },
    devAuditEvent: { async findMany() { return []; } }
  };
}

function reportFor(sessions) {
  return loadPayrollReport(prismaFixture(sessions), { periodType: 'CUSTOM', from: '2026-08-10', to: '2026-08-10' }, { now: new Date('2026-08-10T23:00:00.000Z') });
}

function workerRow(id, { totalMinutes, ordinaryMinutes, overtimeMinutes, workedDays = 1, exportable = true, hedo = 0 } = {}) {
  return {
    workerId: id,
    fullName: `TEST Auxiliar ${id}`,
    documentType: 'CC',
    documentNumber: `TEST-${id}`,
    phone: '',
    totalMinutes,
    ordinaryMinutes,
    overtimeMinutes,
    unrecognizedOvertimeMinutes: 0,
    workedDays,
    deductedDays: 0,
    netWorkedDays: workedDays,
    exportable,
    conceptMinutes: { HEDO: hedo },
    novelties: exportable ? [] : [{ code: 'TEST', message: 'Novedad de prueba', blocking: true }]
  };
}

test('muestra marcaciones por día sin convertir 7.5 h aisladas en hora extra', async () => {
  const report = await reportFor([sessionFixture()]);
  const day = report.rows[0].daily[0];
  assert.equal(day.ordinaryHours, 7.5);
  assert.equal(day.overtimeHours, 0);
  assert.equal(day.totalHours, 7.5);
  assert.equal(day.markings.length, 1);
  const marking = day.markings[0];
  assert.match(marking.arrivalLabel, /8:00/);
  assert.match(marking.breakStartLabel, /12:00/);
  assert.match(marking.breakEndLabel, /1:00/);
  assert.match(marking.departureLabel, /4:30/);
});

test('identifica marcaciones del día siguiente en turnos nocturnos', async () => {
  const report = await reportFor([sessionFixture({ arrivalAt: '2026-08-11T04:00:00.000Z', departureAt: '2026-08-11T07:00:00.000Z', breakStartAt: null, breakEndAt: null, workedMinutes: 180 })]);
  const marking = report.rows[0].daily[0].markings[0];
  assert.match(marking.departureLabel, /día siguiente/);
});

test('explica novedades en español y no exporta el código interno', async () => {
  const report = await reportFor([sessionFixture({ breakEndAt: null, workedMinutes: 420 })]);
  const novelty = report.rows[0].novelties.find((item) => item.code === 'INCOMPLETE_BREAK');
  assert.match(novelty.message, /almuerzo quedó abierto/i);
  const exported = buildPayrollExportRows(report)[0];
  assert.equal(exported.Estado, 'Con novedades');
  assert.match(exported.Novedades, /Requiere revisión/);
  assert.match(exported.Novedades, /almuerzo quedó abierto/i);
  assert.doesNotMatch(exported.Novedades, /INCOMPLETE_BREAK/);
});

test('selecciona varios auxiliares desde las filas reales del corte y recompone solo los totales visibles', () => {
  const report = {
    filters: { clientId: '', operationPointId: '', workerId: '', search: '' },
    rows: [
      workerRow('TEST-A', { totalMinutes: 420, ordinaryMinutes: 420, overtimeMinutes: 0, hedo: 0 }),
      workerRow('TEST-B', { totalMinutes: 480, ordinaryMinutes: 420, overtimeMinutes: 60, hedo: 60, exportable: false }),
      workerRow('TEST-C', { totalMinutes: 450, ordinaryMinutes: 420, overtimeMinutes: 30, hedo: 30 })
    ],
    workers: [{ id: 'TEST-UNRELATED', fullName: 'No debe aparecer' }],
    totals: {}
  };
  const selected = applyPayrollWorkerSelection(report, ['TEST-A', 'TEST-C']);
  assert.deepEqual(selected.workers.map((worker) => worker.id), ['TEST-A', 'TEST-B', 'TEST-C']);
  assert.deepEqual(selected.rows.map((row) => row.workerId), ['TEST-A', 'TEST-C']);
  assert.equal(selected.filters.workerId, 'TEST-A,TEST-C');
  assert.equal(selected.totals.workers, 2);
  assert.equal(selected.totals.totalMinutes, 870);
  assert.equal(selected.totals.ordinaryMinutes, 840);
  assert.equal(selected.totals.overtimeMinutes, 30);
  assert.equal(selected.totals.totalHours, 14.5);
  assert.equal(selected.totals.overtimeHours, 0.5);
  assert.equal(selected.totals.workedDays, 2);
  assert.equal(selected.totals.conceptMinutes.HEDO, 30);
  assert.equal(selected.totals.workersWithNovelties, 0);

  const commaSeparated = applyPayrollWorkerSelection(report, 'TEST-A,TEST-C');
  assert.deepEqual(commaSeparated.rows.map((row) => row.workerId), ['TEST-A', 'TEST-C']);
  const all = applyPayrollWorkerSelection(report, []);
  assert.equal(all.rows.length, 3);
  assert.equal(all.totals.workersWithNovelties, 1);
});

test('la vista limita el selector a auxiliares reales y compacta novedades y marcaciones sin duplicarlas en el resumen', async () => {
  const [view, detail, css] = await Promise.all([
    readFile(new URL('../src/views/operacionesNomina.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/partials/operacionesNominaTabla.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/operaciones-nomina.css', import.meta.url), 'utf8')
  ]);
  assert.match(view, /<label for="workerId">Auxiliares<\/label>/);
  assert.match(view, /name="workerId" multiple/);
  assert.match(view, /Solo aparecen auxiliares con información en este corte/);
  assert.match(view, /partials\/operacionesNominaTabla/);
  assert.match(view, /operaciones-nomina\.css/);
  assert.doesNotMatch(view, /operaciones-nomina\.js/);

  assert.match(detail, /Marcaciones del día/);
  assert.match(detail, /marking-inline/);
  assert.match(detail, /periodSource/);
  assert.match(detail, /dayNovelties/);
  assert.match(detail, /occurrences/);
  assert.match(detail, /novelty\.message/);
  assert.match(detail, /Requiere revisión:/);
  assert.match(detail, /Informativa:/);
  assert.doesNotMatch(detail, /novelty-summary/);
  assert.doesNotMatch(detail, /Marcaciones que sustentan el cálculo de este día/);
  assert.match(css, /\.novelty-line/);
  assert.match(css, /\.marking-inline/);
});
