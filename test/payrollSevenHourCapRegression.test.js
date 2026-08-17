import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DAILY_ORDINARY_MINUTES,
  MAX_WEEKLY_ORDINARY_MINUTES,
  loadPayrollPolicies,
  savePayrollPolicy
} from '../src/modules/dispatch-payroll/application/payrollReport.js';
import { calculatePayrollConceptReport } from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';

function eightHourSessionWithoutBreak() {
  return {
    id: 'TEST-SESSION-8H',
    arrivalReportedAt: new Date('2026-07-27T13:00:00.000Z'),
    departureReportedAt: new Date('2026-07-27T21:00:00.000Z'),
    expectedStartAt: new Date('2026-07-27T13:00:00.000Z'),
    expectedEndAt: new Date('2026-07-27T21:00:00.000Z'),
    workedMinutes: 480,
    validationStatus: 'MANUAL_VALIDATED',
    marks: [],
    assignment: {
      workerId: 'TEST-WORKER-FLEX',
      worker: {
        id: 'TEST-WORKER-FLEX',
        fullName: 'TEST Auxiliar flexible',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-FLEX',
        phone: 'TEST-PHONE-FLEX'
      },
      serviceRequest: {
        clientName: 'TEST Cliente',
        operationPointName: 'TEST Operación',
        operationPoint: {
          id: 'TEST-POINT-FLEX',
          clientId: 'TEST-CLIENT-FLEX',
          name: 'TEST Operación',
          client: { id: 'TEST-CLIENT-FLEX', name: 'TEST Cliente' }
        }
      }
    }
  };
}

test('una política histórica no cambia la referencia fija 42 h semanales / 7 h diarias', async () => {
  const prisma = {
    devAuditEvent: {
      findMany: async () => [{
        entityId: 'TEST-CLIENT-FLEX',
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
            incompleteBreakPenaltyMinutes: 90
          }
        }
      }]
    }
  };

  const policiesByClientId = await loadPayrollPolicies(prisma, ['TEST-CLIENT-FLEX']);
  const policy = policiesByClientId.get('TEST-CLIENT-FLEX');
  assert.equal(policy.dailyOrdinaryMinutes, MAX_DAILY_ORDINARY_MINUTES);
  assert.equal(policy.weeklyOrdinaryMinutes, MAX_WEEKLY_ORDINARY_MINUTES);

  const report = calculatePayrollConceptReport({
    sessions: [eightHourSessionWithoutBreak()],
    policiesByClientId,
    compensationByWorkerDate: new Map(),
    range: { from: '2026-07-27', to: '2026-07-27' }
  });

  const row = report.rows[0];
  assert.equal(row.totalMinutes, 480);
  assert.equal(row.ordinaryMinutes, 480, 'superar 7 h en un día no dispara extra por sí solo');
  assert.equal(row.overtimeMinutes, 0);
  assert.equal(row.conceptMinutes.HEDO, 0);
  assert.equal(row.daily[0].ordinaryMinutes, 480);
  assert.equal(row.daily[0].overtimeMinutes, 0);
});

test('guardar una política persiste 42 h / 7 h aunque el formulario envíe otros valores', async () => {
  let createdEvent = null;
  const prisma = {
    dispatchClient: {
      findUnique: async () => ({ id: 'TEST-CLIENT-FLEX', name: 'TEST Cliente' })
    },
    devAuditEvent: {
      create: async ({ data }) => {
        createdEvent = data;
        return data;
      }
    }
  };

  const policy = await savePayrollPolicy(prisma, {
    clientId: 'TEST-CLIENT-FLEX',
    actorRole: 'dev',
    actorUsername: 'TEST-DEV',
    weeklyOrdinaryHours: 48,
    dailyOrdinaryHours: 8,
    maxDailyOvertimeHours: 2,
    maxWeeklyOvertimeHours: 12,
    nightStartHour: 19,
    nightEndHour: 6,
    restDay: 0,
    recognizeEarlyArrival: false,
    incompleteBreakPenaltyMinutes: 90
  });

  assert.equal(policy.dailyOrdinaryMinutes, MAX_DAILY_ORDINARY_MINUTES);
  assert.equal(policy.weeklyOrdinaryMinutes, MAX_WEEKLY_ORDINARY_MINUTES);
  assert.equal(createdEvent.metadata.policy.dailyOrdinaryMinutes, MAX_DAILY_ORDINARY_MINUTES);
  assert.equal(createdEvent.metadata.policy.weeklyOrdinaryMinutes, MAX_WEEKLY_ORDINARY_MINUTES);
});
