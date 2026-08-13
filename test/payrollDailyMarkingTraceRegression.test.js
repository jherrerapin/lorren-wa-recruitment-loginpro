import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPayrollExportRows, loadPayrollReport } from '../src/modules/dispatch-payroll/application/payrollReport.js';

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
      worker: { id: 'TEST-WORKER-TRACE', fullName: 'Auxiliar Prueba Trazabilidad', isTestProfile: false },
      serviceRequest: {
        source: 'INTERNAL', clientName: 'Cliente Prueba', operationPointName: 'Operación Prueba',
        operationPoint: { id: 'TEST-POINT-TRACE', clientId: 'TEST-CLIENT-TRACE', name: 'Operación Prueba', client: { id: 'TEST-CLIENT-TRACE', name: 'Cliente Prueba' } }
      }
    }
  };
}

function prismaFixture(sessions) {
  return {
    dispatchAttendanceSession: { async findMany() { return sessions; } },
    dispatchClient: { async findMany() { return []; } },
    dispatchWorker: { async findMany() { return [{ id: 'TEST-WORKER-TRACE', fullName: 'Auxiliar Prueba Trazabilidad', isTestProfile: false }]; } },
    devAuditEvent: { async findMany() { return []; } }
  };
}

function reportFor(sessions) {
  return loadPayrollReport(prismaFixture(sessions), { periodType: 'CUSTOM', from: '2026-08-10', to: '2026-08-10' }, { now: new Date('2026-08-10T23:00:00.000Z') });
}

test('muestra marcaciones por día sin alterar ordinarias y extras', async () => {
  const report = await reportFor([sessionFixture()]);
  const day = report.rows[0].daily[0];
  assert.equal(day.ordinaryHours, 7);
  assert.equal(day.overtimeHours, 0.5);
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

test('la vista usa explicaciones y muestra la trazabilidad diaria', async () => {
  const view = await readFile(new URL('../src/views/operacionesNomina.ejs', import.meta.url), 'utf8');
  assert.match(view, /Marcaciones que sustentan el cálculo de este día/);
  assert.match(view, /novelty\.message/);
  assert.match(view, /Requiere revisión/);
  assert.match(view, /Informativa/);
  assert.doesNotMatch(view, /dayNovelty\.map\(\(item\) => item\.code\)/);
  assert.doesNotMatch(view, /<%= row\.status %>/);
});
