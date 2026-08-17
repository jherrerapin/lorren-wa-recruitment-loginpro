import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
import {
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

test('una jornada aislada de 8 h genera una hora extra aunque el valor semanal siga persistido por compatibilidad', () => {
  const historicalPolicy = {
    weeklyOrdinaryMinutes: 48 * 60,
    dailyOrdinaryMinutes: 8 * 60,
    maxDailyOvertimeMinutes: 2 * 60,
    maxWeeklyOvertimeMinutes: 12 * 60,
    nightStartMinute: 19 * 60,
    nightEndMinute: 6 * 60,
    weekStartsOn: 0,
    restDay: 0,
    recognizeEarlyArrival: false,
    incompleteBreakPenaltyMinutes: 90
  };

  const normalized = normalizePayrollPolicy(historicalPolicy);
  assert.equal(normalized.dailyOrdinaryMinutes, 420);
  assert.equal(normalized.weeklyOrdinaryMinutes, 2520);
  assert.equal(normalized.weekStartsOn, 1);

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
});

test('la política nocturna se muestra como 19:00 y 06:00, no como números aislados', async () => {
  const template = await readFile('src/views/operacionesNomina.ejs', 'utf8');
  const html = ejs.render(template, {
    pageTitle: 'Nómina y tiempo trabajado',
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
