import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
import {
  PAYROLL_COMPENSATION_STATUS,
  PAYROLL_CONCEPT_CODES,
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

function makePrisma({ contractType = 'DIRECTO', sessions = [], auditEvents = [] } = {}) {
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
});

test('el backend guarda descanso para ambos contratos y solo exige motivo a Directo', async () => {
  const direct = makePrisma();
  const savedDirect = await saveWorkerRestAssignment(direct.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-11', reason: WORKER_REST_REASONS.SUSPENSION,
    actorUsername: 'TEST-ADMIN'
  });
  assert.equal(savedDirect.dayAdjustment, -1);
  assert.equal(savedDirect.requiresJustification, true);
  const activeDirect = await loadWorkerRestAssignments(direct.prisma, {
    workerIds: ['TEST-WORKER-1'], from: '2026-08-11', to: '2026-08-11'
  });
  assert.equal(activeDirect.length, 1);
  assert.equal(activeDirect[0].reason, WORKER_REST_REASONS.SUSPENSION);
  assert.ok(direct.events.some((event) => (
    event.entityType === WORKER_REST_ENTITY_TYPE && event.action === WORKER_REST_ACTION && event.metadata?.dayAdjustment === -1
  )));

  const directWithoutReason = makePrisma();
  await assert.rejects(
    saveWorkerRestAssignment(directWithoutReason.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-11'
    }),
    /worker_rest_invalid/
  );
  assert.equal(directWithoutReason.events.length, 0);

  const contractor = makePrisma({ contractType: 'CONTRATISTA' });
  const savedContractor = await saveWorkerRestAssignment(contractor.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-11',
    reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-09'
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
});

test('el día de descanso no puede ser domingo ni festivo', async () => {
  const sunday = makePrisma();
  await assert.rejects(
    saveWorkerRestAssignment(sunday.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-09', reason: WORKER_REST_REASONS.VACACIONES
    }),
    /worker_rest_invalid/
  );
  assert.equal(sunday.events.length, 0);

  const holiday = makePrisma();
  await assert.rejects(
    saveWorkerRestAssignment(holiday.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-07-20', reason: WORKER_REST_REASONS.VACACIONES
    }),
    /worker_rest_invalid/
  );
  assert.equal(holiday.events.length, 0);
});

test('Remunerado exige domingo anterior trabajado y no permite reutilizarlo', async () => {
  const sundaySession = payrollSession({
    id: 'TEST-WORKED-SUNDAY',
    arrivalAt: '2026-08-09T23:00:00.000Z',
    departureAt: '2026-08-10T03:00:00.000Z',
    workedMinutes: 240
  });
  const state = makePrisma({ sessions: [sundaySession] });

  await assert.rejects(
    saveWorkerRestAssignment(state.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-12',
      reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-08'
    }),
    /worker_rest_origin_sunday_invalid/
  );
  await assert.rejects(
    saveWorkerRestAssignment(state.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-20',
      reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-16'
    }),
    /worker_rest_origin_sunday_not_worked/
  );

  const saved = await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-12',
    reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-09'
  });
  assert.equal(saved.originSundayDate, '2026-08-09');

  await assert.rejects(
    saveWorkerRestAssignment(state.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-13',
      reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-09'
    }),
    /worker_rest_origin_sunday_used/
  );
});

test('el descanso remunerado gobierna el domingo: sin vínculo no compensa, con vínculo sí y al cancelar vuelve a no compensado', async () => {
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
    reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-09'
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

test('Nómina refleja días trabajados, descontados y netos', async () => {
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

test('Asignaciones usa fecha operativa, justifica Directos y muestra calendario solo para Remunerado', async () => {
  const [route, view] = await Promise.all([
    readFile('src/routes/dispatchOpsExtras.js', 'utf8'),
    readFile('src/views/operacionesAsignacionesConfirmacion.ejs', 'utf8')
  ]);
  assert.match(route, /saveWorkerRestAssignment/);
  assert.match(route, /cancelWorkerRestAssignment/);
  assert.match(route, /router\.post\('\/asignaciones\/descansos'/);
  assert.match(route, /router\.post\('\/asignaciones\/descansos\/cancelar'/);
  assert.match(view, /id="restDropZone"/);
  assert.match(view, /data-contract-type="<%= worker\.contractType %>"/);
  assert.doesNotMatch(view, /card\.dataset\.contractType!=='DIRECTO'/);
  assert.match(view, /type="hidden" name="restDate" id="restDateValue"/);
  assert.doesNotMatch(view, /id="restDateInput"/);
  assert.match(view, /id="restReasonField"/);
  assert.match(view, /const direct=contractType==='DIRECTO'/);
  assert.match(view, /reasonField\.hidden=!direct/);
  assert.match(view, /reasonInput\.required=direct/);
  assert.match(view, /const remunerado=direct&&reasonInput\?\.value==='REMUNERADO'/);
  assert.match(view, /field\.hidden=!remunerado/);
  assert.match(view, /origin\.required=remunerado/);
  assert.match(view, /Sin justificación requerida/);
  assert.match(view, /VACACIONES:'Vacaciones'/);
  assert.match(view, /INCAPACIDAD_EPS:'Incapacidad EPS'/);
  assert.match(view, /SUSPENSION:'Suspensión'/);
  assert.match(view, /INCAPACIDAD_ARL:'Incapacidad ARL'/);
  assert.match(view, /NO_REMUNERADA:'No remunerada'/);
  assert.match(view, /REMUNERADO:'Remunerado'/);
  assert.match(view, /id="originSundayDateInput"/);
  assert.match(view, /getUTCDay\(\)!==0/);
  assert.match(view, /Descuenta 1 día/);
});

test('la vista de Nómina muestra descanso, descuento y domingo sin selector manual', async () => {
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
        totalMinutes: 360, ordinaryHours: 6, overtimeHours: 0, unrecognizedOvertimeMinutes: 0, workersWithNovelties: 0
      }
    },
    selectedPolicy: normalizePayrollPolicy({}),
    conceptCodes: PAYROLL_CONCEPT_CODES,
    formatPayrollMinutes,
    success: null,
    error: null
  });

  assert.match(html, /Días descontados/);
  assert.match(html, /Suspensión/);
  assert.match(html, /Descuenta 1 día laborado/);
  assert.match(html, /No compensado · sin descanso remunerado asignado/);
  assert.match(html, />Festivo<\/span>/);
  assert.doesNotMatch(html, /action="\/admin\/operaciones\/asistencia\/nomina\/compensation"/);
});
