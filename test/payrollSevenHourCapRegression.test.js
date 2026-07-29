import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DAILY_ORDINARY_MINUTES,
  MAX_WEEKLY_ORDINARY_MINUTES,
  loadPayrollPolicies
} from '../src/modules/dispatch-payroll/application/payrollReport.js';
import { calculatePayrollConceptReport } from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function eightHourSessionWithoutBreak() {
  return {
    id: 'session-9-to-5',
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

test('una política histórica de ocho horas no convierte todo el turno 9 a 5 en ordinario', async () => {
  const prisma = {
    devAuditEvent: {
      findMany: async () => [{
        entityId: 'client-test',
        metadata: {
          policy: {
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
          }
        }
      }]
    }
  };

  const policiesByClientId = await loadPayrollPolicies(prisma, ['client-test']);
  const policy = policiesByClientId.get('client-test');

  assert.equal(policy.dailyOrdinaryMinutes, MAX_DAILY_ORDINARY_MINUTES);
  assert.equal(policy.weeklyOrdinaryMinutes, MAX_WEEKLY_ORDINARY_MINUTES);

  const report = calculatePayrollConceptReport({
    sessions: [eightHourSessionWithoutBreak()],
    policiesByClientId,
    compensationByWorkerDate: new Map(),
    range: { from: '2026-07-27', to: '2026-07-27' }
  });

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].totalMinutes, 480);
  assert.equal(report.rows[0].ordinaryMinutes, 420);
  assert.equal(report.rows[0].overtimeMinutes, 60);
  assert.equal(report.rows[0].conceptMinutes.HEDO, 60);
  assert.equal(report.rows[0].daily[0].ordinaryMinutes, 420);
  assert.equal(report.rows[0].daily[0].overtimeMinutes, 60);
});
