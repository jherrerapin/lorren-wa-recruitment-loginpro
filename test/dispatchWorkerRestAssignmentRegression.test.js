import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
import {
  PAYROLL_COMPENSATION_STATUS,
  PAYROLL_CONCEPT_CODES,
  colombianHolidayKeys,
  formatPayrollMinutes,
  normalizePayrollPolicy
} from '../src/modules/dispatch-payroll/domain/payrollConceptEngine.js';
import {
  PAYROLL_COMPENSATION_ACTION,
  PAYROLL_COMPENSATION_ENTITY_TYPE,
  WORKER_REST_ACTION,
  WORKER_REST_ENTITY_TYPE,
  WORKER_REST_REASONS,
  cancelWorkerRestAssignment,
  loadPayrollCompensationMap,
  loadPayrollReport,
  loadWorkerRestAssignments,
  resolveWorkerRestDatePolicy,
  savePayrollCompensation,
  saveWorkerRestAssignment,
  workerRestDayAdjustment
} from '../src/modules/dispatch-payroll/application/payrollReport.js';

function payrollSession({
  id,
  arrivalAt,
  departureAt,
  workedMinutes,
  workerId = 'TEST-WORKER-1',
  clientId = 'TEST-CLIENT-1'
}) {
  return {
    id,
    arrivalReportedAt: new Date(arrivalAt),
    departureReportedAt: new Date(departureAt),
    expectedStartAt: new Date(arrivalAt),
    expectedEndAt: new Date(departureAt),
    workedMinutes,
    validationStatus: 'MANUAL_VALIDATED',
    marks: [],
    assignment: {
      workerId,
      worker: {
        id: workerId,
        fullName: 'Auxiliar de prueba',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-1',
        phone: 'TEST-PHONE-1',
        contractType: 'DIRECTO',
        isTestProfile: false
      },
      serviceRequest: {
        source: 'INTERNAL',
        clientName: 'Cliente de prueba',
        operationPointName: 'Operación de prueba',
        operationPoint: {
          id: 'TEST-POINT-1',
          clientId,
          name: 'Operación de prueba',
          client: { id: clientId, name: 'Cliente de prueba' }
        }
      }
    }
  };
}

function makePrisma({ contractType = 'DIRECTO', sessions = [], auditEvents = [], assignments = [] } = {}) {
  const events = [...auditEvents];
  let sequence = events.length;
  const prisma = {
    dispatchWorker: {
      async findUnique({ where }) {
        if (where.id !== 'TEST-WORKER-1') return null;
        return { id: 'TEST-WORKER-1', fullName: 'Auxiliar de prueba', contractType };
      },
      async findMany() {
        return [{
          id: 'TEST-WORKER-1', fullName: 'Auxiliar de prueba', documentType: 'CC',
          documentNumber: 'TEST-DOC-1', phone: 'TEST-PHONE-1', contractType, isTestProfile: false
        }];
      }
    },
    dispatchAssignment: {
      async findMany({ where }) {
        const workerIds = Array.isArray(where?.workerId?.in) ? where.workerId.in : [];
        const statuses = Array.isArray(where?.status?.in) ? where.status.in : [];
        const gte = where?.serviceRequest?.serviceDate?.gte;
        const lt = where?.serviceRequest?.serviceDate?.lt;
        return assignments
          .filter((item) => !workerIds.length || workerIds.includes(item.workerId))
          .filter((item) => !statuses.length || statuses.includes(item.status))
          .filter((item) => !gte || new Date(item.serviceDate) >= gte)
          .filter((item) => !lt || new Date(item.serviceDate) < lt)
          .map((item) => ({
            workerId: item.workerId,
            worker: { fullName: item.workerName || 'Auxiliar de prueba' },
            serviceRequest: { id: item.serviceRequestId || 'TEST-REQUEST-1' }
          }));
      }
    },
    dispatchAttendanceSession: {
      async findMany() { return sessions; }
    },
    dispatchClient: {
      async findMany() { return []; }
    },
    devAuditEvent: {
      async findMany({ where }) {
        return events
          .filter((event) => !where?.entityType || event.entityType === where.entityType)
          .filter((event) => !where?.action || event.action === where.action)
          .filter((event) => {
            const ids = where?.entityId?.in;
            return !Array.isArray(ids) || ids.includes(event.entityId);
          })
          .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
      },
      async create({ data }) {
        sequence += 1;
        const event = {
          ...data,
          id: `TEST-AUDIT-${sequence}`,
          createdAt: new Date(`2026-08-${String(10 + sequence).padStart(2, '0')}T12:00:00.000Z`)
        };
        events.push(event);
        return event;
      }
    }
  };
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma, events };
}

function restAudit({ restDate, reason, status = 'ACTIVE', originSundayDate = null, createdAt = '2026-08-10T12:00:00.000Z' }) {
  return {
    entityType: WORKER_REST_ENTITY_TYPE,
    entityId: `TEST-WORKER-1|${restDate}`,
    action: WORKER_REST_ACTION,
    createdAt: new Date(createdAt),
    metadata: {
      workerId: 'TEST-WORKER-1', restDate, reason, status, originSundayDate,
      dayAdjustment: workerRestDayAdjustment(reason)
    }
  };
}

test('Suspensión y No remunerada descuentan un día; los demás motivos no', () => {
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.SUSPENSION), -1);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.NO_REMUNERADA), -1);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.VACACIONES), 0);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.INCAPACIDAD_EPS), 0);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.INCAPACIDAD_ARL), 0);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.REMUNERADO), 0);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.COMPENSATORIO), 0);
});

test('el backend guarda descanso para ambos contratos y la justificación es opcional para Directo', async () => {
  const direct = makePrisma();
  const savedDirect = await saveWorkerRestAssignment(direct.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-11', reason: WORKER_REST_REASONS.SUSPENSION,
    actorUsername: 'TEST-ADMIN'
  });
  assert.equal(savedDirect.dayAdjustment, -1);
  assert.equal(savedDirect.requiresJustification, false);
  const activeDirect = await loadWorkerRestAssignments(direct.prisma, {
    workerIds: ['TEST-WORKER-1'], from: '2026-08-11', to: '2026-08-11'
  });
  assert.equal(activeDirect.length, 1);
  assert.equal(activeDirect[0].reason, WORKER_REST_REASONS.SUSPENSION);
  assert.ok(direct.events.some((event) => (
    event.entityType === WORKER_REST_ENTITY_TYPE && event.action === WORKER_REST_ACTION && event.metadata?.dayAdjustment === -1
  )));

  const directWithoutReason = makePrisma();
  const savedDirectWithoutReason = await saveWorkerRestAssignment(directWithoutReason.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-11'
  });
  assert.equal(savedDirectWithoutReason.reason, null);
  assert.equal(savedDirectWithoutReason.originSundayDate, null);
  assert.equal(savedDirectWithoutReason.dayAdjustment, 0);
  assert.equal(savedDirectWithoutReason.requiresJustification, false);
  assert.equal(directWithoutReason.events.length, 1);

  const remunerated = await loadPayrollReport(directWithoutReason.prisma, {
    periodType: 'CUSTOM', from: '2026-08-11', to: '2026-08-11'
  }, { now: new Date('2026-08-11T18:00:00.000Z') });
  assert.equal(remunerated.rows.length, 1);
  assert.equal(remunerated.rows[0].workedDays, 0);
  assert.equal(remunerated.rows[0].remuneratedDays, 1);
  assert.equal(remunerated.rows[0].unremuneratedDays, 0);

  const workedSameDate = payrollSession({
    id: 'TEST-WORKED-REST-DATE',
    arrivalAt: '2026-08-11T13:00:00.000Z',
    departureAt: '2026-08-11T20:00:00.000Z',
    workedMinutes: 420
  });
  const directWorked = makePrisma({
    sessions: [workedSameDate],
    auditEvents: [restAudit({ restDate: '2026-08-11', reason: null })]
  });
  const workedReport = await loadPayrollReport(directWorked.prisma, {
    periodType: 'CUSTOM', from: '2026-08-11', to: '2026-08-11'
  }, { now: new Date('2026-08-11T21:00:00.000Z') });
  assert.equal(workedReport.rows.length, 1);
  assert.equal(workedReport.rows[0].workedDays, 1);
  assert.equal(workedReport.rows[0].remuneratedDays, 1, 'el descanso no duplica un día ya trabajado');

  const contractor = makePrisma({ contractType: 'CONTRATISTA' });
  const savedContractor = await saveWorkerRestAssignment(contractor.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-11',
    reason: WORKER_REST_REASONS.COMPENSATORIO, originSundayDate: '2026-08-16'
  });
  assert.equal(savedContractor.reason, null);
  assert.equal(savedContractor.originSundayDate, null);
  assert.equal(savedContractor.dayAdjustment, 0);
  assert.equal(savedContractor.requiresJustification, false);
  const activeContractor = await loadWorkerRestAssignments(contractor.prisma, {
    workerIds: ['TEST-WORKER-1'], from: '2026-08-11', to: '2026-08-11'
  });
  assert.equal(activeContractor.length, 1);
  assert.equal(activeContractor[0].reason, null);
  assert.equal(activeContractor[0].originSundayDate, null);
  assert.equal(activeContractor[0].dayAdjustment, 0);
  const contractorReport = await loadPayrollReport(contractor.prisma, {
    periodType: 'CUSTOM', from: '2026-08-11', to: '2026-08-11'
  }, { now: new Date('2026-08-11T18:00:00.000Z') });
  assert.equal(contractorReport.rows.length, 1);
  assert.equal(contractorReport.rows[0].remuneratedDays, 0);
});

test('un descanso con solicitud activa exige confirmación explícita sin desasignar al auxiliar', async () => {
  const activeAssignment = {
    workerId: 'TEST-WORKER-1',
    workerName: 'Auxiliar de prueba',
    serviceRequestId: 'TEST-REQUEST-A',
    serviceDate: '2026-08-11T00:00:00.000Z',
    status: 'CONFIRMED'
  };
  const blocked = makePrisma({ assignments: [activeAssignment] });
  await assert.rejects(
    saveWorkerRestAssignment(blocked.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-11', reason: WORKER_REST_REASONS.VACACIONES
    }),
    /worker_rest_active_assignment_confirmation_required/
  );
  assert.equal(blocked.events.length, 0);

  const approved = makePrisma({ assignments: [activeAssignment] });
  const saved = await saveWorkerRestAssignment(approved.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-11', reason: WORKER_REST_REASONS.VACACIONES,
    allowAssignedRest: true
  });
  assert.equal(saved.assignmentConflictOverride, true);
  assert.equal(approved.events.length, 1);

  const inactive = makePrisma({ assignments: [{ ...activeAssignment, status: 'CANCELLED' }] });
  const savedInactive = await saveWorkerRestAssignment(inactive.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-11', reason: WORKER_REST_REASONS.VACACIONES
  });
  assert.equal(savedInactive.assignmentConflictOverride, false);
  assert.equal(inactive.events.length, 1);
});

test('domingo y festivo permiten justificación opcional a Directo, pero no Compensatorio', async () => {
  const sundayPolicy = resolveWorkerRestDatePolicy('2026-08-09');
  assert.equal(sundayPolicy.valid, true);
  assert.equal(sundayPolicy.isSunday, true);
  assert.equal(sundayPolicy.isNaturalRestDay, true);

  const naturalSunday = makePrisma();
  const savedNaturalSunday = await saveWorkerRestAssignment(naturalSunday.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-09'
  });
  assert.equal(savedNaturalSunday.reason, null);
  assert.equal(savedNaturalSunday.originSundayDate, null);
  assert.equal(savedNaturalSunday.dayAdjustment, 0);
  assert.equal(savedNaturalSunday.requiresJustification, false);

  const justifiedSunday = makePrisma();
  const savedJustifiedSunday = await saveWorkerRestAssignment(justifiedSunday.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-09', reason: WORKER_REST_REASONS.SUSPENSION
  });
  assert.equal(savedJustifiedSunday.reason, WORKER_REST_REASONS.SUSPENSION);
  assert.equal(savedJustifiedSunday.originSundayDate, null);
  assert.equal(savedJustifiedSunday.dayAdjustment, -1);
  assert.equal(savedJustifiedSunday.requiresJustification, false);
  const loadedJustifiedSunday = await loadWorkerRestAssignments(justifiedSunday.prisma, {
    workerIds: ['TEST-WORKER-1'], from: '2026-08-09', to: '2026-08-09'
  });
  assert.equal(loadedJustifiedSunday.length, 1);
  assert.equal(loadedJustifiedSunday[0].reason, WORKER_REST_REASONS.SUSPENSION);
  assert.equal(loadedJustifiedSunday[0].dayAdjustment, -1);
  assert.equal(loadedJustifiedSunday[0].requiresJustification, false);

  const invalidCompensatorySunday = makePrisma();
  await assert.rejects(
    saveWorkerRestAssignment(invalidCompensatorySunday.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-09',
      reason: WORKER_REST_REASONS.COMPENSATORIO, originSundayDate: '2026-08-16'
    }),
    /worker_rest_invalid/
  );
  assert.equal(invalidCompensatorySunday.events.length, 0);

  assert.ok(colombianHolidayKeys(2026).has('2026-08-17'));
  const holidayPolicy = resolveWorkerRestDatePolicy('2026-08-17');
  assert.equal(holidayPolicy.valid, true);
  assert.equal(holidayPolicy.isHoliday, true);
  assert.equal(holidayPolicy.isSunday, false);
  assert.equal(holidayPolicy.isNaturalRestDay, true);

  const naturalHoliday = makePrisma();
  const savedNaturalHoliday = await saveWorkerRestAssignment(naturalHoliday.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-17'
  });
  assert.equal(savedNaturalHoliday.reason, null);
  assert.equal(savedNaturalHoliday.originSundayDate, null);
  assert.equal(savedNaturalHoliday.dayAdjustment, 0);
  assert.equal(savedNaturalHoliday.requiresJustification, false);

  const justifiedHoliday = makePrisma();
  const savedJustifiedHoliday = await saveWorkerRestAssignment(justifiedHoliday.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-17', reason: WORKER_REST_REASONS.NO_REMUNERADA
  });
  assert.equal(savedJustifiedHoliday.reason, WORKER_REST_REASONS.NO_REMUNERADA);
  assert.equal(savedJustifiedHoliday.originSundayDate, null);
  assert.equal(savedJustifiedHoliday.dayAdjustment, -1);
  assert.equal(savedJustifiedHoliday.requiresJustification, false);
  const loadedJustifiedHoliday = await loadWorkerRestAssignments(justifiedHoliday.prisma, {
    workerIds: ['TEST-WORKER-1'], from: '2026-08-17', to: '2026-08-17'
  });
  assert.equal(loadedJustifiedHoliday.length, 1);
  assert.equal(loadedJustifiedHoliday[0].reason, WORKER_REST_REASONS.NO_REMUNERADA);
  assert.equal(loadedJustifiedHoliday[0].dayAdjustment, -1);
  assert.equal(loadedJustifiedHoliday[0].requiresJustification, false);

  const invalidCompensatoryHoliday = makePrisma();
  await assert.rejects(
    saveWorkerRestAssignment(invalidCompensatoryHoliday.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-17',
      reason: WORKER_REST_REASONS.COMPENSATORIO, originSundayDate: '2026-08-16'
    }),
    /worker_rest_invalid/
  );
  assert.equal(invalidCompensatoryHoliday.events.length, 0);

  const weekdayPolicy = resolveWorkerRestDatePolicy('2026-08-11');
  assert.equal(weekdayPolicy.isNaturalRestDay, false);
});

test('un descanso natural conserva la confirmación si ya existe asignación activa', async () => {
  const activeSundayAssignment = {
    workerId: 'TEST-WORKER-1',
    workerName: 'Auxiliar de prueba',
    serviceRequestId: 'TEST-REQUEST-SUNDAY',
    serviceDate: '2026-08-09T00:00:00.000Z',
    status: 'CONFIRMED'
  };
  const blocked = makePrisma({ assignments: [activeSundayAssignment] });
  await assert.rejects(
    saveWorkerRestAssignment(blocked.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-09'
    }),
    /worker_rest_active_assignment_confirmation_required/
  );
  assert.equal(blocked.events.length, 0);

  const approved = makePrisma({ assignments: [activeSundayAssignment] });
  const saved = await saveWorkerRestAssignment(approved.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-09', allowAssignedRest: true
  });
  assert.equal(saved.requiresJustification, false);
  assert.equal(saved.assignmentConflictOverride, true);
  assert.equal(approved.events.length, 1);
});

test('Compensatorio permite domingo futuro no trabajado, suma día remunerado y no permite reutilizarlo', async () => {
  const sessions = [];
  const state = makePrisma({ sessions });
  const saved = await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-11',
    reason: WORKER_REST_REASONS.COMPENSATORIO, originSundayDate: '2026-08-16'
  });
  assert.equal(saved.reason, WORKER_REST_REASONS.COMPENSATORIO);
  assert.equal(saved.originSundayDate, '2026-08-16');
  assert.equal(state.events.length, 1);

  const remunerated = await loadPayrollReport(state.prisma, {
    periodType: 'CUSTOM', from: '2026-08-11', to: '2026-08-11'
  }, { now: new Date('2026-08-11T18:00:00.000Z') });
  assert.equal(remunerated.rows.length, 1);
  assert.equal(remunerated.rows[0].workedDays, 0);
  assert.equal(remunerated.rows[0].remuneratedDays, 1);

  await assert.rejects(
    saveWorkerRestAssignment(state.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-12',
      reason: WORKER_REST_REASONS.COMPENSATORIO, originSundayDate: '2026-08-16'
    }),
    /worker_rest_origin_sunday_used/
  );

  const invalidWeekday = makePrisma();
  await assert.rejects(
    saveWorkerRestAssignment(invalidWeekday.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-11',
      reason: WORKER_REST_REASONS.COMPENSATORIO, originSundayDate: '2026-08-15'
    }),
    /worker_rest_origin_sunday_invalid/
  );

  assert.ok(colombianHolidayKeys(2030).has('2030-12-08'));
  assert.equal(new Date('2030-12-08T00:00:00.000Z').getUTCDay(), 0);
  const holidaySunday = makePrisma();
  await assert.rejects(
    saveWorkerRestAssignment(holidaySunday.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2030-12-09',
      reason: WORKER_REST_REASONS.COMPENSATORIO, originSundayDate: '2030-12-08'
    }),
    /worker_rest_origin_sunday_invalid/
  );

  sessions.push(payrollSession({
    id: 'TEST-FUTURE-SUNDAY',
    arrivalAt: '2026-08-16T13:00:00.000Z',
    departureAt: '2026-08-16T17:00:00.000Z',
    workedMinutes: 240
  }));
  const report = await loadPayrollReport(state.prisma, {
    periodType: 'CUSTOM', from: '2026-08-16', to: '2026-08-16'
  }, { now: new Date('2026-08-16T18:00:00.000Z') });
  assert.equal(report.rows[0].conceptMinutes.RDDC, 240);
});

test('Remunerado es permiso remunerado y no conserva un domingo asociado', async () => {
  const state = makePrisma();
  const saved = await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-11',
    reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-16'
  });
  assert.equal(saved.reason, WORKER_REST_REASONS.REMUNERADO);
  assert.equal(saved.originSundayDate, null);
  const active = await loadWorkerRestAssignments(state.prisma, { workerIds: ['TEST-WORKER-1'] });
  assert.equal(active[0].reason, WORKER_REST_REASONS.REMUNERADO);
  assert.equal(active[0].originSundayDate, null);
});

test('el descanso compensatorio gobierna el domingo: sin vínculo no compensa, con vínculo sí y al cancelar vuelve a no compensado', async () => {
  const sundaySession = payrollSession({
    id: 'TEST-WORKED-SUNDAY-AUTHORITY',
    arrivalAt: '2026-08-09T23:00:00.000Z',
    departureAt: '2026-08-10T03:00:00.000Z',
    workedMinutes: 240
  });
  const historicalManualCompensation = {
    entityType: PAYROLL_COMPENSATION_ENTITY_TYPE,
    entityId: 'TEST-WORKER-1|2026-08-09',
    action: PAYROLL_COMPENSATION_ACTION,
    createdAt: new Date('2026-08-10T09:00:00.000Z'),
    metadata: {
      workerId: 'TEST-WORKER-1', dateKey: '2026-08-09', status: PAYROLL_COMPENSATION_STATUS.COMPENSATED
    }
  };
  const state = makePrisma({ sessions: [sundaySession], auditEvents: [historicalManualCompensation] });

  let map = await loadPayrollCompensationMap(state.prisma, ['TEST-WORKER-1'], {
    from: '2026-08-09', to: '2026-08-09'
  });
  assert.equal(map.get('TEST-WORKER-1|2026-08-09'), PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED);

  await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-12',
    reason: WORKER_REST_REASONS.COMPENSATORIO, originSundayDate: '2026-08-09'
  });
  map = await loadPayrollCompensationMap(state.prisma, ['TEST-WORKER-1'], {
    from: '2026-08-09', to: '2026-08-09'
  });
  assert.equal(map.get('TEST-WORKER-1|2026-08-09'), PAYROLL_COMPENSATION_STATUS.COMPENSATED);

  await cancelWorkerRestAssignment(state.prisma, { workerId: 'TEST-WORKER-1', restDate: '2026-08-12' });
  map = await loadPayrollCompensationMap(state.prisma, ['TEST-WORKER-1'], {
    from: '2026-08-09', to: '2026-08-09'
  });
  assert.equal(map.get('TEST-WORKER-1|2026-08-09'), PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED);
});

test('un POST manual no puede volver a crear autoridad de compensatorio en domingo', async () => {
  let workerLookupCalled = false;
  const prisma = {
    dispatchWorker: { async findUnique() { workerLookupCalled = true; return null; } },
    devAuditEvent: { async create() { throw new Error('unexpected_audit_write'); } }
  };
  await assert.rejects(
    savePayrollCompensation(prisma, {
      workerId: 'TEST-WORKER-1', dateKey: '2026-08-09',
      status: PAYROLL_COMPENSATION_STATUS.COMPENSATED, actorUsername: 'TEST-ADMIN'
    }),
    /payroll_compensation_invalid/
  );
  assert.equal(workerLookupCalled, false);
});

test('Nómina conserva los contadores internos de compatibilidad de días', async () => {
  const mondaySession = payrollSession({
    id: 'TEST-MONDAY-WORKDAY',
    arrivalAt: '2026-08-03T13:00:00.000Z',
    departureAt: '2026-08-03T20:00:00.000Z',
    workedMinutes: 420
  });
  const state = makePrisma({
    sessions: [mondaySession],
    auditEvents: [restAudit({ restDate: '2026-08-04', reason: WORKER_REST_REASONS.NO_REMUNERADA })]
  });
  const report = await loadPayrollReport(state.prisma, {
    periodType: 'CUSTOM', from: '2026-08-03', to: '2026-08-04'
  }, { now: new Date('2026-08-04T18:00:00.000Z') });

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].workedDays, 1);
  assert.equal(report.rows[0].deductedDays, 1);
  assert.equal(report.rows[0].netWorkedDays, 0);
  assert.equal(report.rows[0].restAssignments[0].reason, WORKER_REST_REASONS.NO_REMUNERADA);
  assert.equal(report.totals.workedDays, 1);
  assert.equal(report.totals.deductedDays, 1);
  assert.equal(report.totals.netWorkedDays, 0);
});

test('Asignaciones usa la política canónica de fecha para motivo, compensatorio, descanso múltiple y conflictos', async () => {
  const [route, view, payroll, confirmUi, boardUi] = await Promise.all([
    readFile('src/routes/dispatchOpsExtras.js', 'utf8'),
    readFile('src/views/operacionesAsignacionesConfirmacion.ejs', 'utf8'),
    readFile('src/modules/dispatch-payroll/application/payrollReport.js', 'utf8'),
    readFile('src/public/assignment-confirm-dialog.js', 'utf8'),
    readFile('src/public/dispatch-assignment-board.js', 'utf8')
  ]);
  assert.match(route, /saveWorkerRestAssignment/);
  assert.match(route, /cancelWorkerRestAssignment/);
  assert.match(route, /findWorkerRestAssignmentConflicts/);
  assert.match(route, /resolveWorkerRestDatePolicy/);
  assert.match(route, /ACTIVE_DISPATCH_ASSIGNMENT_STATUSES/);
  assert.match(route, /checkOnly.*rest-conflicts/);
  assert.match(route, /rest-date-policy/);
  assert.match(route, /allowAssignedRest/);
  assert.match(route, /router\.post\('\/asignaciones\/descansos'/);
  assert.match(route, /String\(req\.body\.workerId \|\| ''\)\.split\(','\)/);
  assert.match(route, /for \(const workerId of workerIds\)/);
  assert.match(route, /descanso\$\{saved !== 1 \? 's asignados' : ' asignado'\}/);
  assert.doesNotMatch(route, /domingo trabajado anterior|trabajo validado del auxiliar en el domingo seleccionado/);

  assert.match(view, /id="restDropZone"/);
  assert.match(view, /id="restSelectedWorkers"/);
  assert.match(view, /Añadir a descanso/);
  assert.match(view, /data-contract-type="<%= worker\.contractType %>"/);
  assert.doesNotMatch(view, /type="date" name="restDate" id="restDateValue"/);
  assert.match(view, /type="hidden" name="restDate" id="restDateValue" value="<%= safeAssignmentDate %>"/);
  assert.match(view, /id="restReasonField"/);
  assert.match(view, />Justificación<\/label>/);
  assert.match(view, /justificación es opcional/);
  assert.doesNotMatch(view, /en días hábiles es obligatoria/);
  assert.match(view, /COMPENSATORIO:'Compensatorio'/);
  assert.match(view, /id="originSundayDateInput"/);
  assert.match(view, /Domingo que generó el compensatorio/);
  assert.match(view, /Descuenta 1 día/);
  assert.doesNotMatch(view, /El descanso no puede quedar en domingo ni festivo/);

  assert.match(boardUi, /let restBatchHasDirect = false/);
  assert.match(boardUi, /refreshRestDatePolicy/);
  assert.match(boardUi, /payload\.set\('checkOnly', 'rest-date-policy'\)/);
  assert.match(boardUi, /const sundayRestDay = restDatePolicy\.isSunday === true/);
  assert.match(boardUi, /const holidayRestDay = restDatePolicy\.isHoliday === true/);
  assert.match(boardUi, /const reasonAvailable = restBatchHasDirect/);
  assert.match(boardUi, /const reasonRequired = false/);
  assert.match(boardUi, /reasonField\.hidden = !reasonAvailable/);
  assert.match(boardUi, /reasonInput\.required = reasonRequired/);
  assert.match(boardUi, /compensatoryOption\.hidden = naturalRestDay/);
  assert.match(boardUi, /compensatoryOption\.disabled = naturalRestDay/);
  assert.match(boardUi, /Domingo: la justificación es opcional para auxiliares Directos/);
  assert.match(boardUi, /Festivo: la justificación es opcional para auxiliares Directos/);
  assert.match(boardUi, /Día hábil: la justificación es opcional para auxiliares Directos/);
  assert.match(boardUi, /const compensatorio = reasonAvailable && !naturalRestDay/);
  assert.match(boardUi, /field\.hidden = !compensatorio \|\| bulkCompensatorio/);
  assert.match(boardUi, /origin\.required = compensatorio && !bulkCompensatorio/);
  assert.match(boardUi, /Domingo que generó el compensatorio/);
  assert.match(boardUi, /workerInput\.value = cards\.map\(\(card\) => card\.dataset\.workerId\)\.join\(','\)/);
  assert.match(boardUi, /const selectedDate = currentDateFilter\(\)/);
  assert.match(boardUi, /Selecciona una fecha operativa antes de registrar un descanso/);
  assert.match(boardUi, /restDate\.value = selectedDate/);
  assert.match(boardUi, /const canSendReason = worker\.contractType === 'DIRECTO'/);
  assert.match(boardUi, /Descanso guardado sin justificación/);
  assert.doesNotMatch(boardUi, /if \(!reason && !policy\.isNaturalRestDay\)/);
  assert.doesNotMatch(boardUi, /!restDatePolicy\.isHoliday \|\| restDatePolicy\.isSunday/);
  assert.doesNotMatch(boardUi, /restDate\.value = currentDateFilter\(\) \|\| todayDateInColombia\(\)/);
  assert.doesNotMatch(boardUi, /#restDateValue'\)\?\.addEventListener\('change'/);
  assert.match(boardUi, /openRestDialog\(ids\)/);
  assert.doesNotMatch(boardUi, /fecha de descanso válida que no sea domingo/);
  assert.doesNotMatch(boardUi, /Asigna el descanso auxiliar por auxiliar/);
  assert.doesNotMatch(boardUi, /Debe ser un domingo anterior, trabajado por este auxiliar y no festivo/);
  assert.doesNotMatch(boardUi, /dateBefore\(|origin\.max=|origin>=restDateValue/);

  assert.match(payroll, /COMPENSATORIO: 'COMPENSATORIO'/);
  assert.match(payroll, /rawReason === WORKER_REST_REASONS\.REMUNERADO && originSundayDate/);
  assert.match(payroll, /const requiresJustification = false/);
  assert.match(payroll, /const reason = isDirect \? \(requestedReason \|\| null\) : null/);
  assert.match(payroll, /requestedReason === WORKER_REST_REASONS\.COMPENSATORIO/);
  assert.match(payroll, /const dayAdjustment = reason \? workerRestDayAdjustment\(reason\) : 0/);
  assert.match(payroll, /rest\.reason === WORKER_REST_REASONS\.COMPENSATORIO/);
  assert.match(payroll, /const directRestDateKeys = new Set/);
  assert.match(payroll, /const remuneratedDateKeys = new Set\(\[\.\.\.workedDateKeys, \.\.\.compensatoryDateKeys, \.\.\.directRestDateKeys\]\)/);
  assert.match(payroll, /ACTIVE_DISPATCH_ASSIGNMENT_STATUSES/);
  assert.match(payroll, /worker_rest_active_assignment_confirmation_required/);
  assert.match(payroll, /assignmentConflictOverride/);
  assert.doesNotMatch(payroll, /workedSundayIsEligible/);
  assert.doesNotMatch(payroll, /originSundayDate >= restDate/);
  assert.doesNotMatch(payroll, /worker_rest_origin_sunday_not_worked/);

  assert.match(confirmUi, /askRestConflictConfirmation/);
  assert.match(confirmUi, /checkOnly.*rest-conflicts/);
  assert.match(confirmUi, /allowAssignedRest/);
  assert.match(confirmUi, /No asignar descanso/);
  assert.match(confirmUi, /Sí, asignar descanso/);
  assert.match(confirmUi, /descansos\/cancelar/);
  assert.doesNotMatch(confirmUi, /\b(?:window\.)?alert\s*\(/);
  assert.doesNotMatch(confirmUi, /window\.confirm\s*=/);
});

test('la vista de Nómina muestra nuevos contadores, descanso y domingo sin selector manual', async () => {
  const template = await readFile('src/views/operacionesNomina.ejs', 'utf8');
  const emptyConcepts = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0]));
  const html = ejs.render(template, {
    pageTitle: 'Nómina y tiempo trabajado',
    role: 'admin',
    report: {
      period: { periodType: 'WEEKLY', from: '2026-08-17', to: '2026-08-23', anchor: '2026-08-17' },
      filters: { clientId: '', operationPointId: '', workerId: '', search: '', includeTest: false },
      clients: [], workers: [],
      rows: [{
        workerId: 'TEST-WORKER-1', fullName: 'Auxiliar de prueba', documentType: 'CC', documentNumber: 'TEST-DOC-1',
        exportable: true, status: 'CALCULADO', workedDays: 2, deductedDays: 1, netWorkedDays: 1,
        remuneratedDays: 2, unremuneratedDays: 1, paidPermissionDays: 0, incapacityDays: 0,
        nightShiftCount: 0, sundayCount: 1, holidayCount: 1,
        restAssignments: [{
          restDate: '2026-08-20', reason: WORKER_REST_REASONS.SUSPENSION,
          dayAdjustment: -1, originSundayDate: null
        }],
        totalHours: 6, ordinaryHours: 6, overtimeHours: 0, unrecognizedOvertimeHours: 0,
        conceptHours: { ...emptyConcepts, RDF: 2, RDD: 1, RND: 3 }, novelties: [],
        daily: [{
          dateKey: '2026-08-17', totalHours: 2, ordinaryHours: 2, overtimeHours: 0, unrecognizedOvertimeHours: 0,
          clientNames: ['Cliente de prueba'], operationNames: ['Operación de prueba'], civilDateKeys: ['2026-08-17'],
          isHoliday: true, isRestDay: false, compensationStatus: null, compensationManagedByRestAssignment: false
        }, {
          dateKey: '2026-08-23', totalHours: 4, ordinaryHours: 4, overtimeHours: 0, unrecognizedOvertimeHours: 0,
          clientNames: ['Cliente de prueba'], operationNames: ['Operación de prueba'], civilDateKeys: ['2026-08-23'],
          isHoliday: false, isRestDay: true, compensationDateKey: '2026-08-23',
          compensationStatus: PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED, compensationManagedByRestAssignment: true
        }]
      }],
      totals: {
        workers: 1, workedDays: 2, deductedDays: 1, netWorkedDays: 1,
        remuneratedDays: 2, unremuneratedDays: 1, paidPermissionDays: 0, incapacityDays: 0,
        nightShiftCount: 0, sundayCount: 1, holidayCount: 1,
        totalMinutes: 360, ordinaryHours: 6, overtimeHours: 0, unrecognizedOvertimeMinutes: 0, workersWithNovelties: 0
      }
    },
    selectedPolicy: normalizePayrollPolicy({}),
    conceptCodes: PAYROLL_CONCEPT_CODES,
    formatPayrollMinutes,
    success: null,
    error: null
  });

  assert.match(html, /Días remunerados/);
  assert.match(html, /Días no remunerados/);
  assert.match(html, /Permisos remunerados/);
  assert.match(html, /Incapacidades/);
  assert.doesNotMatch(html, /Días netos/);
  assert.match(html, /Suspensión/);
  assert.match(html, /Descuenta 1 día laborado/);
  assert.match(html, /No compensado · sin descanso compensatorio asignado/);
  assert.match(html, />Festivo<\/span>/);
  assert.doesNotMatch(html, /action="\/admin\/operaciones\/asistencia\/nomina\/compensation"/);
});