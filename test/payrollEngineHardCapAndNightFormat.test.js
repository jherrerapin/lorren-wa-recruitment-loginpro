import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
import {
  PAYROLL_COMPENSATION_STATUS,
  PAYROLL_CONCEPT_CODES,
  calculatePayrollConceptReport,
  formatPayrollMinutes,
  normalizePayrollPolicy
} from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function isolatedEightHourSession() {
  return {
    id: 'TEST-SESSION-DIRECT-POLICY',
    arrivalReportedAt: new Date('2026-07-27T13:00:00.000Z'),
    departureReportedAt: new Date('2026-07-27T21:00:00.000Z'),
    expectedStartAt: new Date('2026-07-27T13:00:00.000Z'),
    expectedEndAt: new Date('2026-07-27T21:00:00.000Z'),
    workedMinutes: 480,
    validationStatus: 'MANUAL_VALIDATED',
    marks: [],
    assignment: {
      workerId: 'TEST-WORKER-POLICY',
      worker: {
        id: 'TEST-WORKER-POLICY',
        fullName: 'TEST Auxiliar',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-POLICY',
        phone: 'TEST-PHONE-POLICY'
      },
      serviceRequest: {
        clientName: 'TEST Cliente',
        operationPointName: 'TEST Operación',
        operationPoint: {
          id: 'TEST-POINT-POLICY',
          clientId: 'TEST-CLIENT-POLICY',
          name: 'TEST Operación',
          client: { id: 'TEST-CLIENT-POLICY', name: 'TEST Cliente' }
        }
      }
    }
  };
}

function sessionAt({ id, start, end }) {
  const base = isolatedEightHourSession();
  return {
    ...base,
    id,
    arrivalReportedAt: new Date(start),
    departureReportedAt: new Date(end),
    expectedStartAt: new Date(start),
    expectedEndAt: new Date(end),
    workedMinutes: Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 60_000)
  };
}

test('una jornada aislada de 8 h genera una hora extra y los límites históricos no crean novedades', () => {
  const historicalPolicy = {
    weeklyOrdinaryMinutes: 48 * 60,
    dailyOrdinaryMinutes: 8 * 60,
    maxDailyOvertimeMinutes: 0,
    maxWeeklyOvertimeMinutes: 0,
    nightStartMinute: 19 * 60,
    nightEndMinute: 6 * 60,
    weekStartsOn: 0,
    restDay: 2,
    recognizeEarlyArrival: false,
    incompleteBreakPenaltyMinutes: 90
  };

  const normalized = normalizePayrollPolicy(historicalPolicy);
  assert.equal(normalized.dailyOrdinaryMinutes, 420);
  assert.equal(normalized.weeklyOrdinaryMinutes, 2520);
  assert.equal(normalized.weekStartsOn, 1);
  assert.equal(normalized.restDay, 0, 'el día de descanso histórico deja de gobernar el cálculo');

  const report = calculatePayrollConceptReport({
    sessions: [isolatedEightHourSession()],
    policiesByClientId: new Map([['TEST-CLIENT-POLICY', historicalPolicy]]),
    compensationByWorkerDate: new Map(),
    range: { from: '2026-07-27', to: '2026-07-27' }
  });

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].totalMinutes, 480);
  assert.equal(report.rows[0].ordinaryMinutes, 420);
  assert.equal(report.rows[0].overtimeMinutes, 60);
  assert.equal(report.rows[0].conceptMinutes.HEDO, 60);
  assert.equal(report.totals.ordinaryMinutes, 420);
  assert.equal(report.totals.overtimeMinutes, 60);
  assert.ok(!report.rows[0].novelties.some((item) => item.code === 'DAILY_OVERTIME_LIMIT_EXCEEDED'));
  assert.ok(!report.rows[0].novelties.some((item) => item.code === 'WEEKLY_OVERTIME_LIMIT_EXCEEDED'));
  assert.equal(report.rows[0].exportable, true);
});

test('domingo conserva recargo dominical sin depender de restDay ni generar compensatorio pendiente', () => {
  const historicalPolicy = {
    restDay: 2,
    maxDailyOvertimeMinutes: 0,
    maxWeeklyOvertimeMinutes: 0
  };
  const sunday = sessionAt({
    id: 'TEST-SUNDAY-FLEXIBLE',
    start: '2026-08-02T13:00:00.000Z',
    end: '2026-08-02T20:00:00.000Z'
  });
  const report = calculatePayrollConceptReport({
    sessions: [sunday],
    policiesByClientId: new Map([['TEST-CLIENT-POLICY', historicalPolicy]]),
    compensationByWorkerDate: new Map([
      ['TEST-WORKER-POLICY|2026-08-02', PAYROLL_COMPENSATION_STATUS.PENDING]
    ]),
    range: { from: '2026-08-02', to: '2026-08-02' }
  });

  const row = report.rows[0];
  assert.equal(row.totalMinutes, 420);
  assert.equal(row.conceptMinutes.RDD, 420, 'domingo diurno conserva el recargo dominical');
  assert.equal(row.daily[0].isRestDay, true);
  assert.equal(row.daily[0].compensationStatus, PAYROLL_COMPENSATION_STATUS.PENDING);
  assert.ok(!row.novelties.some((item) => item.code === 'COMPENSATION_PENDING'));
  assert.equal(row.exportable, true);
});

test('la vista DEV oculta cliente, máximos de extra y día de descanso de la configuración', async () => {
  const partial = await readFile('src/views/partials/operacionesGestionTiempoTabla.ejs', 'utf8');
  assert.doesNotMatch(partial, /<label>Cliente<\/label>/);
  assert.doesNotMatch(partial, /name="maxDailyOvertimeHours"/);
  assert.doesNotMatch(partial, /name="maxWeeklyOvertimeHours"/);
  assert.doesNotMatch(partial, /name="restDay"/);
  assert.match(partial, /role==='dev'&&report\.filters\.clientId/);
  assert.match(partial, /type="hidden" name="clientId" value="<%= report\.filters\.clientId %>"/);
});

test('la política nocturna se muestra como 19:00 y 06:00, no como números aislados', async () => {
  const template = await readFile('src/views/operacionesGestionTiempo.ejs', 'utf8');
  const html = ejs.render(template, {
    pageTitle: 'Gestión de Tiempo y tiempo trabajado',
    role: 'dev',
    report: {
      period: { periodType: 'CUSTOM', from: '2026-07-27', to: '2026-07-27', anchor: '2026-07-27' },
      filters: { clientId: 'TEST-CLIENT-POLICY', operationPointId: '', workerId: '', search: '', includeTest: true },
      clients: [{ id: 'TEST-CLIENT-POLICY', name: 'TEST Cliente', operationPoints: [] }],
      workers: [],
      rows: [],
      totals: { workers: 0, totalMinutes: 0, ordinaryHours: 0, overtimeHours: 0, workersWithNovelties: 0 }
    },
    selectedPolicy: {
      weeklyOrdinaryMinutes: 2520,
      dailyOrdinaryMinutes: 420,
      maxDailyOvertimeMinutes: 120,
      maxWeeklyOvertimeMinutes: 720,
      nightStartMinute: 1140,
      nightEndMinute: 360,
      weekStartsOn: 1,
      restDay: 0,
      recognizeEarlyArrival: false,
      incompleteBreakPenaltyMinutes: 90,
      holidaySundayPriority: 'HOLIDAY'
    },
    conceptCodes: PAYROLL_CONCEPT_CODES,
    formatPayrollMinutes,
    success: null,
    error: null
  });

  assert.match(html, /name="nightStartHour"/);
  assert.match(html, /value="19" selected>19:00<\/option>/);
  assert.match(html, /name="nightEndHour"/);
  assert.match(html, /value="6" selected>06:00<\/option>/);
  assert.doesNotMatch(html, /name="nightStartHour" type="number"/);
  assert.doesNotMatch(html, /name="nightEndHour" type="number"/);
});
