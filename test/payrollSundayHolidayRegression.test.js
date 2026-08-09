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

function calculate(sessions, {
  from,
  to = from,
  policy = {},
  compensation = new Map()
} = {}) {
  return calculatePayrollConceptReport({
    sessions,
    range: { from, to },
    policiesByClientId: new Map([['TEST-CLIENT-1', policy]]),
    compensationByWorkerDate: compensation
  });
}

function makeRestPrisma({ contractType = 'DIRECTO', sessions = [], auditEvents = [] } = {}) {
  const events = [...auditEvents];
  let sequence = events.length;
  const prisma = {
    dispatchWorker: {
      async findUnique({ where }) {
        if (where.id !== 'TEST-WORKER-1') return null;
        return { id: 'TEST-WORKER-1', fullName: 'Auxiliar de prueba', contractType };
      },
      async findMany() {
        return [{ id: 'TEST-WORKER-1', fullName: 'Auxiliar de prueba', documentType: 'CC', documentNumber: 'TEST-DOC-1', phone: 'TEST-PHONE-1', contractType, isTestProfile: false }];
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
        const event = { ...data, id: `TEST-AUDIT-${sequence}`, createdAt: new Date(`2026-08-${String(10 + sequence).padStart(2, '0')}T12:00:00.000Z`) };
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
      workerId: 'TEST-WORKER-1',
      restDate,
      reason,
      status,
      originSundayDate,
      dayAdjustment: workerRestDayAdjustment(reason)
    }
  };
}

test('domingo de 18:00 a 22:00 separa recargo diurno y nocturno sin perder minutos', () => {
  const sunday = payrollSession({
    id: 'TEST-SUNDAY-ORDINARY',
    arrivalAt: '2026-08-09T23:00:00.000Z',
    departureAt: '2026-08-10T03:00:00.000Z',
    workedMinutes: 240
  });

  const pending = calculate([sunday], {
    from: '2026-08-09',
    compensation: new Map([['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]])
  });
  const pendingRow = pending.rows[0];
  assert.equal(pendingRow.totalMinutes, 240);
  assert.equal(pendingRow.conceptMinutes.RDD, 60);
  assert.equal(pendingRow.conceptMinutes.RND, 180);
  assert.equal(pendingRow.conceptMinutes.RNO, 0);
  assert.equal(pendingRow.daily[0].isRestDay, true);
  assert.equal(pendingRow.daily[0].isHoliday, false);

  const compensated = calculate([sunday], {
    from: '2026-08-09',
    compensation: new Map([['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.COMPENSATED]])
  });
  assert.equal(compensated.rows[0].conceptMinutes.RDDC, 60);
  assert.equal(compensated.rows[0].conceptMinutes.RNDC, 180);
  assert.equal(compensated.rows[0].conceptMinutes.RDD, 0);
  assert.equal(compensated.rows[0].conceptMinutes.RND, 0);
});

test('una política histórica que inicia domingo se normaliza a lunes y no reinicia las 42 horas antes del dominical nocturno', () => {
  const historicalPolicy = {
    weeklyOrdinaryMinutes: 42 * 60,
    dailyOrdinaryMinutes: 7 * 60,
    maxDailyOvertimeMinutes: 2 * 60,
    maxWeeklyOvertimeMinutes: 12 * 60,
    nightStartMinute: 19 * 60,
    nightEndMinute: 6 * 60,
    weekStartsOn: 0,
    restDay: 0,
    holidaySundayPriority: 'REST'
  };
  const normalized = normalizePayrollPolicy(historicalPolicy);
  assert.equal(normalized.weekStartsOn, 1);
  assert.equal(normalized.holidaySundayPriority, 'HOLIDAY');

  const sessions = [];
  for (let day = 3; day <= 8; day += 1) {
    sessions.push(payrollSession({
      id: `TEST-WEEK-${day}`,
      arrivalAt: `2026-08-${String(day).padStart(2, '0')}T13:00:00.000Z`,
      departureAt: `2026-08-${String(day).padStart(2, '0')}T20:00:00.000Z`,
      workedMinutes: 420
    }));
  }
  sessions.push(payrollSession({
    id: 'TEST-SUNDAY-NIGHT-EXTRA',
    arrivalAt: '2026-08-10T00:00:00.000Z',
    departureAt: '2026-08-10T02:00:00.000Z',
    workedMinutes: 120
  }));

  const result = calculate(sessions, {
    from: '2026-08-09',
    policy: historicalPolicy,
    compensation: new Map([['TEST-WORKER-1|2026-08-09', PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED]])
  });
  const row = result.rows[0];
  assert.equal(row.totalMinutes, 120);
  assert.equal(row.ordinaryMinutes, 0);
  assert.equal(row.overtimeMinutes, 120);
  assert.equal(row.conceptMinutes.HEND, 120);
  assert.equal(row.conceptMinutes.RND, 0);
});

test('festivo conserva RDF y RNF como indicativo y nunca abre compensatorio', () => {
  const sessions = [
    payrollSession({
      id: 'TEST-HOLIDAY-DAY',
      arrivalAt: '2026-08-17T13:00:00.000Z',
      departureAt: '2026-08-17T15:00:00.000Z',
      workedMinutes: 120
    }),
    payrollSession({
      id: 'TEST-HOLIDAY-NIGHT',
      arrivalAt: '2026-08-18T00:00:00.000Z',
      departureAt: '2026-08-18T02:00:00.000Z',
      workedMinutes: 120
    })
  ];
  const result = calculate(sessions, {
    from: '2026-08-17',
    compensation: new Map([['TEST-WORKER-1|2026-08-17', PAYROLL_COMPENSATION_STATUS.COMPENSATED]])
  });
  const row = result.rows[0];
  assert.equal(row.conceptMinutes.RDF, 120);
  assert.equal(row.conceptMinutes.RNF, 120);
  assert.equal('RDFC' in row.conceptMinutes, false);
  assert.equal('RNFC' in row.conceptMinutes, false);
  assert.equal(row.daily[0].isHoliday, true);
  assert.equal(row.daily[0].isRestDay, false);
  assert.equal(row.daily[0].compensationStatus, null);
  assert.ok(!row.novelties.some((item) => item.code === 'COMPENSATION_PENDING'));
  assert.equal(row.exportable, true);
});

test('suspensión y no remunerada descuentan un día; los demás motivos no', () => {
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.SUSPENSION), -1);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.NO_REMUNERADA), -1);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.VACACIONES), 0);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.INCAPACIDAD_EPS), 0);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.INCAPACIDAD_ARL), 0);
  assert.equal(workerRestDayAdjustment(WORKER_REST_REASONS.REMUNERADO), 0);
});

test('backend persiste descanso auditable solo para contrato Directo', async () => {
  const direct = makeRestPrisma();
  const saved = await saveWorkerRestAssignment(direct.prisma, {
    workerId: 'TEST-WORKER-1',
    restDate: '2026-08-11',
    reason: WORKER_REST_REASONS.SUSPENSION,
    actorUsername: 'TEST-ADMIN'
  });
  assert.equal(saved.dayAdjustment, -1);
  const active = await loadWorkerRestAssignments(direct.prisma, { workerIds: ['TEST-WORKER-1'], from: '2026-08-11', to: '2026-08-11' });
  assert.equal(active.length, 1);
  assert.equal(active[0].reason, WORKER_REST_REASONS.SUSPENSION);
  assert.equal(active[0].dayAdjustment, -1);
  assert.ok(direct.events.some((event) => event.entityType === WORKER_REST_ENTITY_TYPE && event.action === WORKER_REST_ACTION && event.metadata?.dayAdjustment === -1));

  const contractor = makeRestPrisma({ contractType: 'CONTRATISTA' });
  await assert.rejects(
    saveWorkerRestAssignment(contractor.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-11', reason: WORKER_REST_REASONS.VACACIONES
    }),
    /worker_rest_direct_contract_required/
  );
  assert.equal(contractor.events.length, 0);
});

test('descanso remunerado exige domingo anterior trabajado, no festivo y no reutilizado', async () => {
  const sundaySession = payrollSession({
    id: 'TEST-WORKED-SUNDAY',
    arrivalAt: '2026-08-09T23:00:00.000Z',
    departureAt: '2026-08-10T03:00:00.000Z',
    workedMinutes: 240
  });
  const state = makeRestPrisma({ sessions: [sundaySession] });

  await assert.rejects(
    saveWorkerRestAssignment(state.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-12', reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-08'
    }),
    /worker_rest_origin_sunday_invalid/
  );
  await assert.rejects(
    saveWorkerRestAssignment(state.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-20', reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-16'
    }),
    /worker_rest_origin_sunday_not_worked/
  );

  const saved = await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-12', reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-09'
  });
  assert.equal(saved.originSundayDate, '2026-08-09');

  await assert.rejects(
    saveWorkerRestAssignment(state.prisma, {
      workerId: 'TEST-WORKER-1', restDate: '2026-08-13', reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-09'
    }),
    /worker_rest_origin_sunday_used/
  );
});

test('descanso remunerado es la autoridad del domingo: sin vínculo no compensa y al cancelar vuelve a no compensado', async () => {
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
    metadata: { workerId: 'TEST-WORKER-1', dateKey: '2026-08-09', status: PAYROLL_COMPENSATION_STATUS.COMPENSATED }
  };
  const state = makeRestPrisma({ sessions: [sundaySession], auditEvents: [historicalManualCompensation] });

  let map = await loadPayrollCompensationMap(state.prisma, ['TEST-WORKER-1'], { from: '2026-08-09', to: '2026-08-09' });
  assert.equal(map.get('TEST-WORKER-1|2026-08-09'), PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED);

  await saveWorkerRestAssignment(state.prisma, {
    workerId: 'TEST-WORKER-1', restDate: '2026-08-12', reason: WORKER_REST_REASONS.REMUNERADO, originSundayDate: '2026-08-09'
  });
  map = await loadPayrollCompensationMap(state.prisma, ['TEST-WORKER-1'], { from: '2026-08-09', to: '2026-08-09' });
  assert.equal(map.get('TEST-WORKER-1|2026-08-09'), PAYROLL_COMPENSATION_STATUS.COMPENSATED);

  await cancelWorkerRestAssignment(state.prisma, { workerId: 'TEST-WORKER-1', restDate: '2026-08-12' });
  map = await loadPayrollCompensationMap(state.prisma, ['TEST-WORKER-1'], { from: '2026-08-09', to: '2026-08-09' });
  assert.equal(map.get('TEST-WORKER-1|2026-08-09'), PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED);
});

test('el backend rechaza compensatorio manual tanto en festivo como en domingo', async () => {
  let workerLookupCalled = false;
  let auditCreateCalled = false;
  const prisma = {
    dispatchWorker: {
      async findUnique() {
        workerLookupCalled = true;
        return { id: 'TEST-WORKER-1', fullName: 'Auxiliar de prueba' };
      }
    },
    devAuditEvent: {
      async create() { auditCreateCalled = true; }
    }
  };

  for (const dateKey of ['2026-08-17', '2026-08-09']) {
    await assert.rejects(
      savePayrollCompensation(prisma, {
        workerId: 'TEST-WORKER-1', dateKey, status: PAYROLL_COMPENSATION_STATUS.COMPENSATED, actorUsername: 'TEST-ADMIN'
      }),
      /payroll_compensation_invalid/
    );
  }
  assert.equal(workerLookupCalled, false);
  assert.equal(auditCreateCalled, false);
});

test('reporte de nómina expone días trabajados, descontados y netos', async () => {
  const mondaySession = payrollSession({
    id: 'TEST-MONDAY-WORKDAY',
    arrivalAt: '2026-08-03T13:00:00.000Z',
    departureAt: '2026-08-03T20:00:00.000Z',
    workedMinutes: 420
  });
  const state = makeRestPrisma({
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

test('Asignaciones ofrece zona de descansos, motivos requeridos y control Directo en UI y backend', async () => {
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
  assert.match(view, /card\.dataset\.contractType!=='DIRECTO'/);
  assert.match(view, />Vacaciones</);
  assert.match(view, />Incapacidad EPS</);
  assert.match(view, />Suspensión</);
  assert.match(view, />Incapacidad ARL</);
  assert.match(view, />No remunerada</);
  assert.match(view, />Remunerado</);
  assert.match(view, /id="originSundayDateInput"/);
  assert.match(view, /getUTCDay\(\)!==0/);
  assert.match(view, /Descuenta 1 día/);
});

test('la interfaz de nómina conserva calendario lunes-domingo, festivo y domingo gobernado por descanso asignado', async () => {
  const template = await readFile('src/views/operacionesNomina.ejs', 'utf8');
  const emptyConcepts = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0]));
  const html = ejs.render(template, {
    pageTitle: 'Nómina y tiempo trabajado',
    role: 'admin',
    report: {
      period: { periodType: 'WEEKLY', from: '2026-08-17', to: '2026-08-23', anchor: '2026-08-17' },
      filters: { clientId: '', operationPointId: '', workerId: '', search: '', includeTest: false },
      clients: [],
      workers: [],
      rows: [{
        workerId: 'TEST-WORKER-1',
        fullName: 'Auxiliar de prueba',
        documentType: 'CC',
        documentNumber: 'TEST-DOC-1',
        exportable: true,
        status: 'CALCULADO',
        workedDays: 2,
        deductedDays: 1,
        netWorkedDays: 1,
        restAssignments: [{ restDate: '2026-08-20', reason: WORKER_REST_REASONS.SUSPENSION, dayAdjustment: -1, originSundayDate: null }],
        totalHours: 6,
        ordinaryHours: 6,
        overtimeHours: 0,
        unrecognizedOvertimeHours: 0,
        conceptHours: { ...emptyConcepts, RDF: 2, RDD: 1, RND: 3 },
        novelties: [],
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

  assert.match(html, /<span class="date-weekday">Lun<\/span><span class="date-weekday">Mar<\/span><span class="date-weekday">Mié<\/span><span class="date-weekday">Jue<\/span><span class="date-weekday">Vie<\/span><span class="date-weekday">Sáb<\/span><span class="date-weekday">Dom<\/span>/);
  assert.match(html, /name="anchor" type="hidden"/);
  assert.match(html, /name="from" type="hidden"/);
  assert.match(html, /name="to" type="hidden"/);
  assert.doesNotMatch(html, /type="date"/);
  assert.match(html, /mondayOffset = \(firstOfMonth\.getUTCDay\(\) \+ 6\) % 7/);
  assert.match(html, />Festivo<\/span>/);
  assert.match(html, /Días descontados/);
  assert.match(html, /Suspensión/);
  assert.match(html, /Descuenta 1 día laborado/);
  assert.match(html, /No compensado · sin descanso remunerado asignado/);
  assert.doesNotMatch(html, /action="\/admin\/operaciones\/asistencia\/nomina\/compensation"/);
  assert.doesNotMatch(html, /RDFC|RNFC/);
});
