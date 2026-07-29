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

function sessionFromNineToFive() {
  return {
    id: 'session-direct-policy',
    arrivalReportedAt: new Date('2026-07-27T14:00:00.000Z'),
    departureReportedAt: new Date('2026-07-27T22:00:00.000Z'),
    expectedStartAt: new Date('2026-07-27T14:00:00.000Z'),
    expectedEndAt: new Date('2026-07-27T22:00:00.000Z'),
    workedMinutes: 480,
    validationStatus: 'MANUAL_VALIDATED',
    marks: [],
    assignment: {
      workerId: 'worker-test',
      worker: {
        id: 'worker-test',
        fullName: 'Sujeto de prueba',
        documentType: 'CC',
        documentNumber: '1000000000',
        phone: '3000000000'
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

test('el motor limita directamente una política de ocho horas y genera una hora extra', () => {
  const directEightHourPolicy = {
    weeklyOrdinaryMinutes: 48 * 60,
    dailyOrdinaryMinutes: 8 * 60,
    maxDailyOvertimeMinutes: 2 * 60,
    maxWeeklyOvertimeMinutes: 12 * 60,
    nightStartMinute: 19 * 60,
    nightEndMinute: 6 * 60,
    weekStartsOn: 1,
    restDay: 0,
    recognizeEarlyArrival: false,
    incompleteBreakPenaltyMinutes: 90,
    holidaySundayPriority: 'HOLIDAY'
  };

  const normalized = normalizePayrollPolicy(directEightHourPolicy);
  assert.equal(normalized.dailyOrdinaryMinutes, 420);
  assert.equal(normalized.weeklyOrdinaryMinutes, 2520);

  const report = calculatePayrollConceptReport({
    sessions: [sessionFromNineToFive()],
    policiesByClientId: new Map([['client-test', directEightHourPolicy]]),
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
      filters: { clientId: 'client-test', operationPointId: '', workerId: '', search: '', includeTest: true },
      clients: [{ id: 'client-test', name: 'Cliente prueba', operationPoints: [] }],
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
