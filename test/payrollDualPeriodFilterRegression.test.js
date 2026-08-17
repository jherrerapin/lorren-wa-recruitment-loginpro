import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildOvertimeReportInput,
  combinePayrollPeriodReports
} from '../src/routes/dispatchPayroll.js';

const CONCEPT_CODES = ['HEDO', 'HENO', 'HEDD', 'HEND', 'HEDF', 'HENF', 'RNO', 'RDD', 'RND', 'RDF', 'RNF', 'RDDC', 'RNDC'];

function concepts(values = {}) {
  return Object.fromEntries(CONCEPT_CODES.map((code) => [code, Number(values[code] || 0)]));
}

function hours(values = {}) {
  return Object.fromEntries(CONCEPT_CODES.map((code) => [code, Number(values[code] || 0) / 60]));
}

function row(workerId, overrides = {}) {
  const conceptMinutes = concepts(overrides.conceptMinutes);
  return {
    workerId,
    fullName: overrides.fullName || `Auxiliar ${workerId}`,
    documentType: 'CC',
    documentNumber: `TEST-${workerId}`,
    phone: '',
    totalMinutes: overrides.totalMinutes ?? 420,
    ordinaryMinutes: overrides.ordinaryMinutes ?? 420,
    overtimeMinutes: overrides.overtimeMinutes ?? 0,
    unrecognizedOvertimeMinutes: overrides.unrecognizedOvertimeMinutes ?? 0,
    totalHours: (overrides.totalMinutes ?? 420) / 60,
    ordinaryHours: (overrides.ordinaryMinutes ?? 420) / 60,
    overtimeHours: (overrides.overtimeMinutes ?? 0) / 60,
    unrecognizedOvertimeHours: (overrides.unrecognizedOvertimeMinutes ?? 0) / 60,
    conceptMinutes,
    conceptHours: hours(conceptMinutes),
    workedDays: overrides.workedDays ?? 1,
    deductedDays: overrides.deductedDays ?? 0,
    netWorkedDays: overrides.netWorkedDays ?? 1,
    remuneratedDays: overrides.remuneratedDays ?? 1,
    unremuneratedDays: overrides.unremuneratedDays ?? 0,
    paidPermissionDays: overrides.paidPermissionDays ?? 0,
    incapacityDays: overrides.incapacityDays ?? 0,
    nightShiftCount: overrides.nightShiftCount ?? 0,
    sundayCount: overrides.sundayCount ?? 0,
    holidayCount: overrides.holidayCount ?? 0,
    restAssignments: [],
    daily: [],
    novelties: overrides.novelties || [],
    status: overrides.status || 'CALCULADO',
    exportable: overrides.exportable ?? true
  };
}

function report(period, rows) {
  return {
    period,
    rows,
    totals: {},
    filters: {},
    clients: [],
    workers: [],
    generatedAt: new Date('2026-08-17T12:00:00.000Z')
  };
}

test('periodo de extras es independiente y por defecto conserva el rango general', () => {
  const generalPeriod = { periodType: 'BIWEEKLY', from: '2026-08-01', to: '2026-08-15', anchor: '2026-08-01' };

  assert.deepEqual(
    buildOvertimeReportInput({ periodType: 'BIWEEKLY', anchor: '2026-08-01' }, generalPeriod),
    {
      periodType: 'CUSTOM', anchor: '2026-08-01',
      from: '2026-08-01', to: '2026-08-15'
    }
  );

  const weekly = buildOvertimeReportInput({
    periodType: 'BIWEEKLY', from: '2026-08-01', to: '2026-08-15',
    extraPeriodType: 'WEEKLY', extraAnchor: '2026-08-12'
  }, generalPeriod);
  assert.equal(weekly.periodType, 'WEEKLY');
  assert.equal(weekly.anchor, '2026-08-12');
  assert.equal(weekly.from, undefined);
  assert.equal(weekly.to, undefined);

  const oneDay = buildOvertimeReportInput({
    periodType: 'BIWEEKLY',
    extraPeriodType: 'CUSTOM', extraFrom: '2026-08-17', extraTo: '2026-08-17'
  }, generalPeriod);
  assert.equal(oneDay.periodType, 'CUSTOM');
  assert.equal(oneDay.from, '2026-08-17');
  assert.equal(oneDay.to, '2026-08-17');

  assert.throws(() => buildOvertimeReportInput({ extraPeriodType: 'BIWEEKLY' }, generalPeriod), /payroll_range_invalid/);
});

test('un solo resultado conserva datos generales y toma únicamente H* del periodo de extras', () => {
  const general = report(
    { periodType: 'BIWEEKLY', from: '2026-08-01', to: '2026-08-15', anchor: '2026-08-01' },
    [
      row('TEST-A', {
        totalMinutes: 840,
        ordinaryMinutes: 780,
        overtimeMinutes: 60,
        remuneratedDays: 2,
        paidPermissionDays: 1,
        conceptMinutes: { HEDO: 60, RNO: 30 }
      }),
      row('TEST-B', { conceptMinutes: { HEDO: 60, RDF: 20 } })
    ]
  );
  const overtime = report(
    { periodType: 'WEEKLY', from: '2026-08-10', to: '2026-08-16', anchor: '2026-08-10' },
    [
      row('TEST-A', {
        totalMinutes: 900,
        ordinaryMinutes: 855,
        overtimeMinutes: 45,
        conceptMinutes: { HENO: 45, RNO: 300 }
      }),
      row('TEST-C', {
        totalMinutes: 480,
        ordinaryMinutes: 420,
        overtimeMinutes: 60,
        conceptMinutes: { HEDD: 60, RDD: 60 },
        novelties: [{ code: 'TEST_BLOCK', dateKey: '2026-08-16', message: 'Revisión de prueba', blocking: true }],
        status: 'CON_NOVEDADES',
        exportable: false
      }),
      row('TEST-D', { totalMinutes: 0, ordinaryMinutes: 0, workedDays: 0, remuneratedDays: 0 })
    ]
  );

  const combined = combinePayrollPeriodReports(general, overtime);
  assert.deepEqual(combined.period, general.period);
  assert.deepEqual(combined.overtimePeriod, overtime.period);
  assert.deepEqual(combined.rows.map((item) => item.workerId), ['TEST-A', 'TEST-B', 'TEST-C']);

  const a = combined.rows.find((item) => item.workerId === 'TEST-A');
  assert.equal(a.totalMinutes, 840);
  assert.equal(a.ordinaryMinutes, 780);
  assert.equal(a.remuneratedDays, 2);
  assert.equal(a.paidPermissionDays, 1);
  assert.equal(a.conceptMinutes.RNO, 30, 'el recargo pertenece al periodo general');
  assert.equal(a.conceptMinutes.HEDO, 0);
  assert.equal(a.conceptMinutes.HENO, 45);
  assert.equal(a.overtimeMinutes, 45);

  const b = combined.rows.find((item) => item.workerId === 'TEST-B');
  assert.equal(b.conceptMinutes.HEDO, 0, 'un H* del corte general no debe filtrarse como extra si no está en el periodo de extras');
  assert.equal(b.conceptMinutes.RDF, 20);
  assert.equal(b.overtimeMinutes, 0);

  const c = combined.rows.find((item) => item.workerId === 'TEST-C');
  assert.equal(c.totalMinutes, 0);
  assert.equal(c.ordinaryMinutes, 0);
  assert.equal(c.remuneratedDays, 0);
  assert.equal(c.conceptMinutes.RDD, 0, 'un auxiliar extra-only no trae recargos del periodo de extras al corte general');
  assert.equal(c.conceptMinutes.HEDD, 60);
  assert.equal(c.overtimeMinutes, 60);
  assert.equal(c.exportable, false);
  assert.equal(c.status, 'CON_NOVEDADES');
  assert.equal(c.novelties[0].code, 'TEST_BLOCK');

  assert.equal(combined.totals.totalMinutes, 1260);
  assert.equal(combined.totals.overtimeMinutes, 105);
  assert.equal(combined.totals.conceptMinutes.RNO, 30);
  assert.equal(combined.totals.conceptMinutes.RDF, 20);
  assert.equal(combined.totals.conceptMinutes.HENO, 45);
  assert.equal(combined.totals.conceptMinutes.HEDD, 60);
  assert.equal(combined.totals.workersWithNovelties, 1);
});

test('la vista usa dos filtros independientes y un solo calendario reutilizable, sin Desde/Hasta visibles', async () => {
  const [view, route, table] = await Promise.all([
    readFile('src/views/operacionesNomina.ejs', 'utf8'),
    readFile('src/routes/dispatchPayroll.js', 'utf8'),
    readFile('src/views/partials/operacionesNominaTabla.ejs', 'utf8')
  ]);

  assert.match(view, /Periodo general/);
  assert.match(view, /data-general-mode="FIRST">1–15/);
  assert.match(view, /data-general-mode="SECOND">16–/);
  assert.match(view, /data-general-mode="CUSTOM">Personalizado/);
  assert.match(view, /Horas extras/);
  assert.match(view, /data-overtime-mode="WEEKLY">Semanal/);
  assert.match(view, /data-overtime-mode="CUSTOM">Personalizado/);
  assert.equal((view.match(/id="payrollRangeDialog"/g) || []).length, 1);
  assert.doesNotMatch(view, /<label>Desde<\/label>|<label>Hasta<\/label>/);
  assert.doesNotMatch(view, /name="from" type="date"|name="to" type="date"|name="extraFrom" type="date"|name="extraTo" type="date"/);
  assert.match(view, /name="extraPeriodType"/);
  assert.match(view, /name="extraFrom"/);
  assert.match(view, /name="extraTo"/);
  assert.match(view, /name="extraAnchor"/);
  assert.equal((view.match(/include\('partials\/operacionesNominaTabla'\)/g) || []).length, 1);

  assert.match(route, /combinePayrollPeriodReports\(generalReport, overtimeReport\)/);
  assert.match(route, /const generalReport = await loadPayrollReport/);
  assert.match(route, /const overtimeReport = sameResolvedRange[\s\S]*loadPayrollReport\(prisma, overtimeInput/);
  assert.match(route, /'extraPeriodType', 'extraFrom', 'extraTo', 'extraAnchor'/);

  for (const field of ['extraPeriodType', 'extraFrom', 'extraTo', 'extraAnchor']) {
    assert.ok((table.match(new RegExp(`name="${field}"`, 'g')) || []).length >= 2, `${field} debe conservarse en política y compensatorio`);
  }
});
