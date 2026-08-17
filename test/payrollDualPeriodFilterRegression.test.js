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

function daily(dateKey, overrides = {}) {
  const conceptMinutes = concepts(overrides.conceptMinutes);
  const totalMinutes = overrides.totalMinutes ?? 420;
  const ordinaryMinutes = overrides.ordinaryMinutes ?? 420;
  const overtimeMinutes = overrides.overtimeMinutes ?? 0;
  const unrecognizedOvertimeMinutes = overrides.unrecognizedOvertimeMinutes ?? 0;
  return {
    dateKey,
    totalMinutes,
    ordinaryMinutes,
    overtimeMinutes,
    unrecognizedOvertimeMinutes,
    totalHours: totalMinutes / 60,
    ordinaryHours: ordinaryMinutes / 60,
    overtimeHours: overtimeMinutes / 60,
    unrecognizedOvertimeHours: unrecognizedOvertimeMinutes / 60,
    conceptMinutes,
    conceptHours: hours(conceptMinutes),
    clientNames: overrides.clientNames || ['Cliente TEST'],
    operationNames: overrides.operationNames || ['Operación TEST'],
    civilDateKeys: overrides.civilDateKeys || [dateKey],
    holidayDateKeys: overrides.holidayDateKeys || [],
    restDateKeys: overrides.restDateKeys || [],
    isHoliday: overrides.isHoliday ?? false,
    isRestDay: overrides.isRestDay ?? false,
    compensationDateKey: overrides.compensationDateKey ?? null,
    compensationStatus: overrides.compensationStatus ?? null,
    compensationManagedByRestAssignment: overrides.compensationManagedByRestAssignment ?? false,
    markings: overrides.markings || [],
    novelties: overrides.novelties || []
  };
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
    daily: overrides.daily || [],
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

  const withDimensionFilters = buildOvertimeReportInput({
    periodType: 'BIWEEKLY',
    extraPeriodType: 'CUSTOM', extraFrom: '2026-08-10', extraTo: '2026-08-16',
    clientId: 'TEST-CLIENT', operationPointId: 'TEST-POINT', search: 'TEST búsqueda', includeTest: 'true'
  }, generalPeriod);
  assert.equal(withDimensionFilters.clientId, 'TEST-CLIENT');
  assert.equal(withDimensionFilters.operationPointId, 'TEST-POINT');
  assert.equal(withDimensionFilters.search, 'TEST búsqueda');
  assert.equal(withDimensionFilters.includeTest, 'true');

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
        conceptMinutes: { HEDO: 60, RNO: 30 },
        daily: [
          daily('2026-08-05', {
            totalMinutes: 480, ordinaryMinutes: 420, overtimeMinutes: 60,
            conceptMinutes: { HEDO: 60 },
            markings: [{ sessionId: 'TEST-GENERAL-ONLY' }]
          }),
          daily('2026-08-10', {
            totalMinutes: 360, ordinaryMinutes: 360,
            conceptMinutes: { RNO: 30 },
            markings: [{ sessionId: 'TEST-OVERLAP-GENERAL' }]
          })
        ]
      }),
      row('TEST-B', {
        conceptMinutes: { HEDO: 60, RDF: 20 },
        daily: [
          daily('2026-08-06', {
            totalMinutes: 480, ordinaryMinutes: 420, overtimeMinutes: 60,
            conceptMinutes: { HEDO: 60, RDF: 20 }
          })
        ]
      })
    ]
  );
  const overtime = report(
    { periodType: 'WEEKLY', from: '2026-08-10', to: '2026-08-16', anchor: '2026-08-10' },
    [
      row('TEST-A', {
        totalMinutes: 900,
        ordinaryMinutes: 825,
        overtimeMinutes: 75,
        conceptMinutes: { HENO: 45, HEDD: 30, RNO: 300 },
        daily: [
          daily('2026-08-10', {
            totalMinutes: 465, ordinaryMinutes: 420, overtimeMinutes: 45,
            conceptMinutes: { HENO: 45, RNO: 45 },
            markings: [{ sessionId: 'TEST-OVERLAP-EXTRAS' }]
          }),
          daily('2026-08-16', {
            totalMinutes: 450, ordinaryMinutes: 420, overtimeMinutes: 30,
            conceptMinutes: { HEDD: 30, RDD: 420 },
            isRestDay: true,
            compensationDateKey: '2026-08-16',
            compensationStatus: 'NOT_COMPENSATED',
            compensationManagedByRestAssignment: true,
            markings: [{ sessionId: 'TEST-EXTRAS-ONLY' }]
          })
        ]
      }),
      row('TEST-C', {
        totalMinutes: 480,
        ordinaryMinutes: 420,
        overtimeMinutes: 60,
        conceptMinutes: { HEDD: 60, RDD: 60 },
        daily: [
          daily('2026-08-16', {
            totalMinutes: 480, ordinaryMinutes: 420, overtimeMinutes: 60,
            conceptMinutes: { HEDD: 60, RDD: 60 },
            isRestDay: true,
            compensationDateKey: '2026-08-16',
            compensationStatus: 'NOT_COMPENSATED',
            compensationManagedByRestAssignment: true,
            markings: [{ sessionId: 'TEST-C-EXTRAS-ONLY' }]
          })
        ],
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
  assert.equal(a.conceptMinutes.HEDD, 30);
  assert.equal(a.overtimeMinutes, 75);
  assert.deepEqual(a.daily.map((day) => day.dateKey), ['2026-08-05', '2026-08-10', '2026-08-16']);

  const aGeneralOnly = a.daily.find((day) => day.dateKey === '2026-08-05');
  assert.equal(aGeneralOnly.totalMinutes, 480);
  assert.equal(aGeneralOnly.ordinaryMinutes, 420);
  assert.equal(aGeneralOnly.overtimeMinutes, 0);
  assert.equal(aGeneralOnly.conceptMinutes.HEDO, 0, 'el detalle general no conserva H* fuera del filtro de extras');
  assert.equal(aGeneralOnly.markings[0].sessionId, 'TEST-GENERAL-ONLY');

  const aOverlap = a.daily.find((day) => day.dateKey === '2026-08-10');
  assert.equal(aOverlap.totalMinutes, 360, 'total diario pertenece al corte general');
  assert.equal(aOverlap.ordinaryMinutes, 360, 'ordinarias diarias pertenecen al corte general');
  assert.equal(aOverlap.conceptMinutes.RNO, 30, 'R* diario pertenece al corte general');
  assert.equal(aOverlap.overtimeMinutes, 45, 'extra diaria pertenece al filtro de extras');
  assert.equal(aOverlap.conceptMinutes.HENO, 45, 'H* diario pertenece al filtro de extras');
  assert.equal(aOverlap.markings[0].sessionId, 'TEST-OVERLAP-GENERAL', 'la trazabilidad del día común se conserva desde el corte general');

  const aExtrasOnly = a.daily.find((day) => day.dateKey === '2026-08-16');
  assert.equal(aExtrasOnly.totalMinutes, 0, 'una fecha solo de extras no infla el total del corte general');
  assert.equal(aExtrasOnly.ordinaryMinutes, 0);
  assert.equal(aExtrasOnly.conceptMinutes.RDD, 0, 'una fecha solo de extras no importa R* al corte general');
  assert.equal(aExtrasOnly.overtimeMinutes, 30);
  assert.equal(aExtrasOnly.conceptMinutes.HEDD, 30);
  assert.equal(aExtrasOnly.markings[0].sessionId, 'TEST-EXTRAS-ONLY');
  assert.equal(aExtrasOnly.compensationDateKey, null, 'no habilita compensatorio fuera del corte general');
  assert.equal(aExtrasOnly.compensationStatus, null);
  assert.equal(aExtrasOnly.compensationManagedByRestAssignment, false);

  const b = combined.rows.find((item) => item.workerId === 'TEST-B');
  assert.equal(b.conceptMinutes.HEDO, 0, 'un H* del corte general no debe filtrarse como extra si no está en el periodo de extras');
  assert.equal(b.conceptMinutes.RDF, 20);
  assert.equal(b.overtimeMinutes, 0);
  assert.equal(b.daily[0].conceptMinutes.HEDO, 0);
  assert.equal(b.daily[0].conceptMinutes.RDF, 20);

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
  assert.equal(c.daily.length, 1);
  assert.equal(c.daily[0].totalMinutes, 0);
  assert.equal(c.daily[0].ordinaryMinutes, 0);
  assert.equal(c.daily[0].overtimeMinutes, 60);
  assert.equal(c.daily[0].conceptMinutes.HEDD, 60);
  assert.equal(c.daily[0].conceptMinutes.RDD, 0);
  assert.equal(c.daily[0].markings[0].sessionId, 'TEST-C-EXTRAS-ONLY');
  assert.equal(c.daily[0].compensationStatus, null);

  assert.equal(combined.totals.totalMinutes, 1260);
  assert.equal(combined.totals.overtimeMinutes, 135);
  assert.equal(combined.totals.conceptMinutes.RNO, 30);
  assert.equal(combined.totals.conceptMinutes.RDF, 20);
  assert.equal(combined.totals.conceptMinutes.HENO, 45);
  assert.equal(combined.totals.conceptMinutes.HEDD, 90);
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
