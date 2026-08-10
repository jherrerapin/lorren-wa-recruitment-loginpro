import {
  DEFAULT_PAYROLL_POLICY,
  PAYROLL_COMPENSATION_STATUS,
  PAYROLL_CONCEPT_CODES,
  addDateKeyDays,
  bogotaDayStart,
  calculatePayrollConceptReport,
  colombianHolidayKeys,
  normalizePayrollPolicy,
  payrollWeekStartKey
} from '../domain/payrollConceptEngine.js';

export const PAYROLL_POLICY_ENTITY_TYPE = 'DISPATCH_PAYROLL_POLICY';
export const PAYROLL_POLICY_ACTION = 'PAYROLL_POLICY_UPDATED';
export const PAYROLL_COMPENSATION_ENTITY_TYPE = 'DISPATCH_PAYROLL_COMPENSATION';
export const PAYROLL_COMPENSATION_ACTION = 'PAYROLL_COMPENSATION_UPDATED';
export const WORKER_REST_ENTITY_TYPE = 'DISPATCH_WORKER_REST_ASSIGNMENT';
export const WORKER_REST_ACTION = 'WORKER_REST_ASSIGNMENT_UPDATED';
export const WORKER_REST_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  CANCELLED: 'CANCELLED'
});
export const WORKER_REST_REASONS = Object.freeze({
  VACACIONES: 'VACACIONES',
  INCAPACIDAD_EPS: 'INCAPACIDAD_EPS',
  SUSPENSION: 'SUSPENSION',
  INCAPACIDAD_ARL: 'INCAPACIDAD_ARL',
  NO_REMUNERADA: 'NO_REMUNERADA',
  REMUNERADO: 'REMUNERADO'
});
export const DEV_TEST_REQUEST_SOURCE = 'DEV_TEST';
export const MAX_WEEKLY_ORDINARY_MINUTES = DEFAULT_PAYROLL_POLICY.weeklyOrdinaryMinutes;
export const MAX_DAILY_ORDINARY_MINUTES = DEFAULT_PAYROLL_POLICY.dailyOrdinaryMinutes;

const WORKER_REST_REASON_VALUES = new Set(Object.values(WORKER_REST_REASONS));
const REST_DAY_DEDUCTION_REASONS = new Set([
  WORKER_REST_REASONS.SUSPENSION,
  WORKER_REST_REASONS.NO_REMUNERADA
]);

function normalizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function validDateKey(value) {
  const text = normalizeString(value, 10);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text;
}

function holidayDateKey(dateKey) {
  const validKey = validDateKey(dateKey);
  if (!validKey) return false;
  return colombianHolidayKeys(Number(validKey.slice(0, 4))).has(validKey);
}

function isSundayDateKey(dateKey) {
  const validKey = validDateKey(dateKey);
  if (!validKey) return false;
  return new Date(`${validKey}T00:00:00.000Z`).getUTCDay() === 0;
}

function workerRestKey(workerId, restDate) {
  return `${workerId}|${restDate}`;
}

export function workerRestDayAdjustment(reason) {
  return REST_DAY_DEDUCTION_REASONS.has(String(reason || '').toUpperCase()) ? -1 : 0;
}

function normalizeWorkerRestEvent(event) {
  const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const workerId = normalizeString(metadata.workerId, 120);
  const restDate = validDateKey(metadata.restDate);
  const reason = normalizeString(metadata.reason, 40)?.toUpperCase();
  const status = normalizeString(metadata.status, 40)?.toUpperCase();
  const originSundayDate = validDateKey(metadata.originSundayDate);
  if (!workerId || !restDate || (reason && !WORKER_REST_REASON_VALUES.has(reason)) || !Object.values(WORKER_REST_STATUS).includes(status)) return null;
  return {
    entityId: event.entityId || workerRestKey(workerId, restDate),
    workerId,
    restDate,
    reason: reason || null,
    status,
    originSundayDate: reason === WORKER_REST_REASONS.REMUNERADO ? originSundayDate : null,
    dayAdjustment: workerRestDayAdjustment(reason),
    requiresJustification: metadata.requiresJustification === true || Boolean(reason),
    createdAt: event.createdAt || null
  };
}

function todayBogotaKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function resolvePayrollPeriod(query = {}, now = new Date()) {
  const periodType = ['WEEKLY', 'BIWEEKLY', 'CUSTOM'].includes(String(query.periodType || '').toUpperCase())
    ? String(query.periodType).toUpperCase()
    : 'WEEKLY';
  const today = todayBogotaKey(now);
  let from;
  let to;

  if (periodType === 'CUSTOM') {
    from = validDateKey(query.from) || today;
    to = validDateKey(query.to) || from;
  } else if (periodType === 'BIWEEKLY') {
    const selected = validDateKey(query.anchor) || validDateKey(query.from) || today;
    const [year, month, day] = selected.split('-').map(Number);
    if (day <= 15) {
      from = `${year}-${String(month).padStart(2, '0')}-01`;
      to = `${year}-${String(month).padStart(2, '0')}-15`;
    } else {
      from = `${year}-${String(month).padStart(2, '0')}-16`;
      to = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
    }
  } else {
    const selected = validDateKey(query.anchor) || validDateKey(query.from) || today;
    from = payrollWeekStartKey(selected, 1);
    to = addDateKeyDays(from, 6);
  }

  if (from > to) [from, to] = [to, from];
  const spanDays = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (spanDays > 62) throw new Error('payroll_period_too_long');
  return { periodType, from, to, anchor: validDateKey(query.anchor) || from, spanDays };
}

export function enforceDispatchOrdinaryLimits(source = {}) {
  const policy = normalizePayrollPolicy(source);
  return {
    ...policy,
    weeklyOrdinaryMinutes: Math.min(policy.weeklyOrdinaryMinutes, MAX_WEEKLY_ORDINARY_MINUTES),
    dailyOrdinaryMinutes: Math.min(policy.dailyOrdinaryMinutes, MAX_DAILY_ORDINARY_MINUTES)
  };
}

function policyFromEvent(event) {
  const raw = event?.metadata?.policy;
  return enforceDispatchOrdinaryLimits(raw && typeof raw === 'object' ? raw : {});
}

export async function loadPayrollPolicies(prisma, clientIds = []) {
  const uniqueIds = [...new Set(clientIds.filter(Boolean))];
  const map = new Map();
  if (!uniqueIds.length) return map;
  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: PAYROLL_POLICY_ENTITY_TYPE,
      entityId: { in: uniqueIds },
      action: PAYROLL_POLICY_ACTION
    },
    orderBy: { createdAt: 'desc' }
  });
  for (const event of events) {
    if (!event.entityId || map.has(event.entityId)) continue;
    map.set(event.entityId, policyFromEvent(event));
  }
  uniqueIds.forEach((id) => { if (!map.has(id)) map.set(id, enforceDispatchOrdinaryLimits(DEFAULT_PAYROLL_POLICY)); });
  return map;
}

export async function savePayrollPolicy(prisma, input = {}) {
  const actorRole = normalizeString(input.actorRole, 80)?.toLowerCase();
  if (actorRole !== 'dev') throw new Error('payroll_policy_dev_required');
  const clientId = normalizeString(input.clientId, 120);
  if (!clientId) throw new Error('payroll_policy_client_required');
  const client = await prisma.dispatchClient.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
  if (!client) throw new Error('payroll_policy_client_not_found');

  const policy = enforceDispatchOrdinaryLimits({
    weeklyOrdinaryMinutes: Number(input.weeklyOrdinaryHours) * 60,
    dailyOrdinaryMinutes: Number(input.dailyOrdinaryHours) * 60,
    maxDailyOvertimeMinutes: Number(input.maxDailyOvertimeHours) * 60,
    maxWeeklyOvertimeMinutes: Number(input.maxWeeklyOvertimeHours) * 60,
    nightStartMinute: Number(input.nightStartHour) * 60,
    nightEndMinute: Number(input.nightEndHour) * 60,
    restDay: Number(input.restDay),
    recognizeEarlyArrival: input.recognizeEarlyArrival === true,
    incompleteBreakPenaltyMinutes: Number(input.incompleteBreakPenaltyMinutes),
    version: 'CO-2026-07'
  });

  await prisma.devAuditEvent.create({
    data: {
      entityType: PAYROLL_POLICY_ENTITY_TYPE,
      entityId: client.id,
      entityLabel: client.name,
      action: PAYROLL_POLICY_ACTION,
      actorUsername: normalizeString(input.actorUsername, 160),
      actorRole,
      actorSource: 'payroll-admin',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      toValue: { policy },
      metadata: { policy, legalReferenceVersion: 'CO-2026-07' }
    }
  });
  return policy;
}

export async function loadWorkerRestAssignments(prisma, options = {}) {
  const workerIds = Array.isArray(options.workerIds) ? [...new Set(options.workerIds.filter(Boolean))] : [];
  const workerSet = new Set(workerIds);
  const from = validDateKey(options.from);
  const to = validDateKey(options.to);
  const events = await prisma.devAuditEvent.findMany({
    where: { entityType: WORKER_REST_ENTITY_TYPE, action: WORKER_REST_ACTION },
    orderBy: { createdAt: 'desc' }
  });
  const latestByEntity = new Map();
  for (const event of events) {
    if (!event.entityId || latestByEntity.has(event.entityId)) continue;
    latestByEntity.set(event.entityId, event);
  }
  return [...latestByEntity.values()]
    .map(normalizeWorkerRestEvent)
    .filter(Boolean)
    .filter((rest) => options.includeCancelled === true || rest.status === WORKER_REST_STATUS.ACTIVE)
    .filter((rest) => !workerSet.size || workerSet.has(rest.workerId))
    .filter((rest) => !from || rest.restDate >= from)
    .filter((rest) => !to || rest.restDate <= to)
    .sort((left, right) => right.restDate.localeCompare(left.restDate) || left.workerId.localeCompare(right.workerId));
}

async function workedSundayIsEligible(prisma, workerId, sundayDate) {
  const dayStart = bogotaDayStart(sundayDate);
  const dayEnd = bogotaDayStart(addDateKeyDays(sundayDate, 1));
  const sessions = await prisma.dispatchAttendanceSession.findMany({
    where: {
      assignment: { workerId },
      arrivalReportedAt: { lt: dayEnd },
      departureReportedAt: { gt: dayStart },
      validationStatus: { in: ['AUTO_VALIDATED', 'MANUAL_VALIDATED'] }
    },
    include: {
      marks: { orderBy: { serverReceivedAt: 'asc' } },
      assignment: {
        include: {
          worker: true,
          serviceRequest: {
            include: {
              operationPoint: { include: { client: true } }
            }
          }
        }
      }
    },
    orderBy: { arrivalReportedAt: 'asc' }
  });
  if (!sessions.length) return false;
  const report = calculatePayrollConceptReport({
    sessions,
    defaultPolicy: { ...DEFAULT_PAYROLL_POLICY, restDay: 0 },
    range: { from: addDateKeyDays(sundayDate, -6), to: sundayDate }
  });
  return report.rows.some((row) => row.workerId === workerId && row.daily.some((day) => (
    Number(day.totalMinutes || 0) > 0 && Array.isArray(day.restDateKeys) && day.restDateKeys.includes(sundayDate)
  )));
}

async function inSerializableTransaction(prisma, callback) {
  if (typeof prisma.$transaction !== 'function') return callback(prisma);
  return prisma.$transaction(callback, { isolationLevel: 'Serializable' });
}

export async function saveWorkerRestAssignment(prisma, input = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const restDate = validDateKey(input.restDate);
  const requestedReason = normalizeString(input.reason, 40)?.toUpperCase();
  const requestedOriginSundayDate = validDateKey(input.originSundayDate);
  if (!workerId || !restDate || isSundayDateKey(restDate) || holidayDateKey(restDate)) throw new Error('worker_rest_invalid');

  return inSerializableTransaction(prisma, async (tx) => {
    const worker = await tx.dispatchWorker.findUnique({
      where: { id: workerId },
      select: { id: true, fullName: true, contractType: true }
    });
    if (!worker) throw new Error('worker_rest_worker_not_found');

    const requiresJustification = worker.contractType === 'DIRECTO';
    if (requiresJustification && !WORKER_REST_REASON_VALUES.has(requestedReason)) throw new Error('worker_rest_invalid');
    const reason = requiresJustification ? requestedReason : null;
    const originSundayDate = reason === WORKER_REST_REASONS.REMUNERADO ? requestedOriginSundayDate : null;
    if (reason === WORKER_REST_REASONS.REMUNERADO) {
      if (!originSundayDate || !isSundayDateKey(originSundayDate) || originSundayDate >= restDate || holidayDateKey(originSundayDate)) {
        throw new Error('worker_rest_origin_sunday_invalid');
      }
    }

    const active = await loadWorkerRestAssignments(tx, { workerIds: [worker.id] });
    if (active.some((rest) => rest.restDate === restDate)) throw new Error('worker_rest_date_already_assigned');

    if (reason === WORKER_REST_REASONS.REMUNERADO) {
      const originAlreadyUsed = active.some((rest) => (
        rest.reason === WORKER_REST_REASONS.REMUNERADO && rest.originSundayDate === originSundayDate
      ));
      if (originAlreadyUsed) throw new Error('worker_rest_origin_sunday_used');
      if (!(await workedSundayIsEligible(tx, worker.id, originSundayDate))) throw new Error('worker_rest_origin_sunday_not_worked');
    }

    const status = WORKER_REST_STATUS.ACTIVE;
    const dayAdjustment = requiresJustification ? workerRestDayAdjustment(reason) : 0;
    const metadata = {
      workerId: worker.id,
      restDate,
      reason,
      status,
      originSundayDate,
      dayAdjustment,
      requiresJustification
    };
    await tx.devAuditEvent.create({
      data: {
        entityType: WORKER_REST_ENTITY_TYPE,
        entityId: workerRestKey(worker.id, restDate),
        entityLabel: `${worker.fullName} · ${restDate}`,
        action: WORKER_REST_ACTION,
        actorUsername: normalizeString(input.actorUsername, 160),
        actorRole: normalizeString(input.actorRole, 80),
        actorSource: 'dispatch-assignment-admin',
        ipAddress: normalizeString(input.ipAddress, 120),
        userAgent: normalizeString(input.userAgent, 500),
        toValue: metadata,
        metadata
      }
    });
    return metadata;
  });
}

export async function cancelWorkerRestAssignment(prisma, input = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const restDate = validDateKey(input.restDate);
  if (!workerId || !restDate) throw new Error('worker_rest_invalid');
  return inSerializableTransaction(prisma, async (tx) => {
    const active = await loadWorkerRestAssignments(tx, { workerIds: [workerId], from: restDate, to: restDate });
    const current = active.find((rest) => rest.restDate === restDate);
    if (!current) throw new Error('worker_rest_not_found');
    const status = WORKER_REST_STATUS.CANCELLED;
    const metadata = { ...current, status };
    delete metadata.entityId;
    delete metadata.createdAt;
    await tx.devAuditEvent.create({
      data: {
        entityType: WORKER_REST_ENTITY_TYPE,
        entityId: workerRestKey(workerId, restDate),
        entityLabel: `${workerId} · ${restDate}`,
        action: WORKER_REST_ACTION,
        actorUsername: normalizeString(input.actorUsername, 160),
        actorRole: normalizeString(input.actorRole, 80),
        actorSource: 'dispatch-assignment-admin',
        ipAddress: normalizeString(input.ipAddress, 120),
        userAgent: normalizeString(input.userAgent, 500),
        toValue: metadata,
        metadata
      }
    });
    return metadata;
  });
}

export async function loadPayrollCompensationMap(prisma, workerIds = [], range = {}) {
  const uniqueIds = [...new Set(workerIds.filter(Boolean))];
  const map = new Map();
  if (!uniqueIds.length) return map;
  const rangeFrom = validDateKey(range.from);
  const rangeTo = validDateKey(range.to);
  if (!rangeFrom || !rangeTo || rangeFrom > rangeTo) return map;

  for (const workerId of uniqueIds) {
    for (let dateKey = rangeFrom; dateKey <= rangeTo; dateKey = addDateKeyDays(dateKey, 1)) {
      if (isSundayDateKey(dateKey) && !holidayDateKey(dateKey)) {
        map.set(`${workerId}|${dateKey}`, PAYROLL_COMPENSATION_STATUS.NOT_COMPENSATED);
      }
    }
  }

  const events = await prisma.devAuditEvent.findMany({
    where: { entityType: PAYROLL_COMPENSATION_ENTITY_TYPE, action: PAYROLL_COMPENSATION_ACTION },
    orderBy: { createdAt: 'desc' }
  });

  const workerSet = new Set(uniqueIds);
  for (const event of events) {
    const workerId = normalizeString(event?.metadata?.workerId, 120);
    const dateKey = validDateKey(event?.metadata?.dateKey);
    const status = normalizeString(event?.metadata?.status, 40)?.toUpperCase();
    if (!workerId || !workerSet.has(workerId) || !dateKey || dateKey < rangeFrom || dateKey > rangeTo) continue;
    if (holidayDateKey(dateKey) || isSundayDateKey(dateKey)) continue;
    if (!Object.values(PAYROLL_COMPENSATION_STATUS).includes(status)) continue;
    const key = `${workerId}|${dateKey}`;
    if (!map.has(key)) map.set(key, status);
  }

  const rests = await loadWorkerRestAssignments(prisma, { workerIds: uniqueIds });
  for (const rest of rests) {
    if (rest.reason !== WORKER_REST_REASONS.REMUNERADO) continue;
    const origin = rest.originSundayDate;
    if (!origin || origin < rangeFrom || origin > rangeTo || holidayDateKey(origin)) continue;
    map.set(`${rest.workerId}|${origin}`, PAYROLL_COMPENSATION_STATUS.COMPENSATED);
  }
  return map;
}

export async function savePayrollCompensation(prisma, input = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const dateKey = validDateKey(input.dateKey);
  const status = normalizeString(input.status, 40)?.toUpperCase();
  if (!workerId || !dateKey || !Object.values(PAYROLL_COMPENSATION_STATUS).includes(status) || holidayDateKey(dateKey) || isSundayDateKey(dateKey)) {
    throw new Error('payroll_compensation_invalid');
  }
  const worker = await prisma.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true, fullName: true } });
  if (!worker) throw new Error('payroll_compensation_worker_not_found');
  await prisma.devAuditEvent.create({
    data: {
      entityType: PAYROLL_COMPENSATION_ENTITY_TYPE,
      entityId: `${worker.id}|${dateKey}`,
      entityLabel: `${worker.fullName} · ${dateKey}`,
      action: PAYROLL_COMPENSATION_ACTION,
      actorUsername: normalizeString(input.actorUsername, 160),
      actorRole: normalizeString(input.actorRole, 80),
      actorSource: 'payroll-admin',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      toValue: { status },
      metadata: { workerId: worker.id, dateKey, status }
    }
  });
  return { workerId: worker.id, dateKey, status };
}

function normalizedFilters(query = {}, options = {}) {
  return {
    clientId: normalizeString(query.clientId, 120) || '',
    operationPointId: normalizeString(query.operationPointId, 120) || '',
    workerId: normalizeString(query.workerId, 120) || '',
    search: normalizeString(query.search, 160) || '',
    includeTest: options.allowTestData === true && String(query.includeTest || '').toLowerCase() === 'true'
  };
}

function sessionIsTest(session) {
  return session?.assignment?.serviceRequest?.source === DEV_TEST_REQUEST_SOURCE
    || session?.assignment?.worker?.isTestProfile === true
    || session?.source === 'DEV_TEST_MANUAL';
}

function sessionMatchesFilters(session, filters) {
  const assignment = session?.assignment;
  const worker = assignment?.worker || {};
  const point = assignment?.serviceRequest?.operationPoint || {};
  if (!filters.includeTest && sessionIsTest(session)) return false;
  if (filters.clientId && point.clientId !== filters.clientId) return false;
  if (filters.operationPointId && point.id !== filters.operationPointId) return false;
  if (filters.workerId && worker.id !== filters.workerId) return false;
  if (filters.search) {
    const haystack = [worker.fullName, worker.documentNumber, worker.phone].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}

function emptyPayrollConceptValues() {
  return Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0]));
}

function emptyPayrollRow(worker) {
  return {
    workerId: worker.id,
    fullName: worker.fullName || 'Auxiliar sin nombre',
    documentType: worker.documentType || '',
    documentNumber: worker.documentNumber || '',
    phone: worker.phone || '',
    totalMinutes: 0,
    ordinaryMinutes: 0,
    overtimeMinutes: 0,
    unrecognizedOvertimeMinutes: 0,
    conceptMinutes: emptyPayrollConceptValues(),
    conceptHours: emptyPayrollConceptValues(),
    totalHours: 0,
    ordinaryHours: 0,
    overtimeHours: 0,
    unrecognizedOvertimeHours: 0,
    daily: [],
    novelties: [],
    status: 'CALCULADO',
    exportable: true
  };
}

function decoratePayrollRows(report, workers, rests, filters, filteredSessions) {
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const sessionWorkerIds = new Set(filteredSessions.map((session) => session.assignment?.workerId).filter(Boolean));
  const rowByWorker = new Map(report.rows.map((row) => [row.workerId, row]));
  const search = filters.search.toLowerCase();
  const visibleRests = rests.filter((rest) => {
    const worker = workerById.get(rest.workerId);
    if (!worker) return false;
    if (filters.workerId && rest.workerId !== filters.workerId) return false;
    if (search) {
      const haystack = [worker.fullName, worker.documentNumber, worker.phone].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if ((filters.clientId || filters.operationPointId) && !sessionWorkerIds.has(rest.workerId)) return false;
    return true;
  });

  for (const rest of visibleRests) {
    if (!rowByWorker.has(rest.workerId)) {
      const worker = workerById.get(rest.workerId);
      const row = emptyPayrollRow(worker);
      report.rows.push(row);
      rowByWorker.set(rest.workerId, row);
    }
  }

  for (const row of report.rows) {
    row.restAssignments = visibleRests.filter((rest) => rest.workerId === row.workerId).sort((a, b) => a.restDate.localeCompare(b.restDate));
    row.workedDays = row.daily.filter((day) => Number(day.totalMinutes || 0) > 0).length;
    row.deductedDays = row.restAssignments.filter((rest) => rest.dayAdjustment === -1).length;
    row.netWorkedDays = row.workedDays - row.deductedDays;
    row.daily = row.daily.map((day) => ({
      ...day,
      compensationManagedByRestAssignment: Boolean(day.isRestDay && isSundayDateKey(day.compensationDateKey))
    }));
  }

  report.rows.sort((left, right) => left.fullName.localeCompare(right.fullName, 'es'));
  report.totals.workers = report.rows.length;
  report.totals.exportableWorkers = report.rows.filter((row) => row.exportable).length;
  report.totals.workersWithNovelties = report.rows.filter((row) => !row.exportable).length;
  report.totals.workedDays = report.rows.reduce((sum, row) => sum + row.workedDays, 0);
  report.totals.deductedDays = report.rows.reduce((sum, row) => sum + row.deductedDays, 0);
  report.totals.netWorkedDays = report.rows.reduce((sum, row) => sum + row.netWorkedDays, 0);
  return report;
}

export async function loadPayrollReport(prisma, query = {}, options = {}) {
  const period = resolvePayrollPeriod(query, options.now || new Date());
  const filters = normalizedFilters(query, options);
  const expandedFrom = addDateKeyDays(period.from, -6);
  const start = bogotaDayStart(expandedFrom);
  const end = bogotaDayStart(addDateKeyDays(period.to, 1));

  const [sessions, clients, workers, periodRests] = await Promise.all([
    prisma.dispatchAttendanceSession.findMany({
      where: {
        arrivalReportedAt: { gte: start, lt: end },
        departureReportedAt: { not: null }
      },
      include: {
        marks: { orderBy: { serverReceivedAt: 'asc' } },
        assignment: {
          include: {
            worker: true,
            serviceRequest: {
              include: {
                operationPoint: { include: { client: true } }
              }
            }
          }
        }
      },
      orderBy: { arrivalReportedAt: 'asc' }
    }),
    prisma.dispatchClient.findMany({
      where: { isActive: true, ...(filters.includeTest ? {} : { isTestClient: false }) },
      include: { operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' }
    }),
    prisma.dispatchWorker.findMany({
      where: {
        operationalStatus: { not: 'ELIMINADO' },
        ...(filters.includeTest ? {} : { isTestProfile: false })
      },
      select: { id: true, fullName: true, documentType: true, documentNumber: true, phone: true, contractType: true },
      orderBy: { fullName: 'asc' }
    }),
    loadWorkerRestAssignments(prisma, { from: period.from, to: period.to, ...(filters.workerId ? { workerIds: [filters.workerId] } : {}) })
  ]);

  const filteredSessions = sessions.filter((session) => sessionMatchesFilters(session, filters));
  const clientIds = [...new Set(filteredSessions.map((session) => session.assignment?.serviceRequest?.operationPoint?.clientId).filter(Boolean))];
  const workerIds = [...new Set(filteredSessions.map((session) => session.assignment?.workerId).filter(Boolean))];
  const compensationRange = { from: period.from, to: addDateKeyDays(period.to, 1) };
  const [policiesByClientId, compensationByWorkerDate] = await Promise.all([
    loadPayrollPolicies(prisma, clientIds),
    loadPayrollCompensationMap(prisma, workerIds, compensationRange)
  ]);

  const report = calculatePayrollConceptReport({
    sessions: filteredSessions,
    policiesByClientId,
    compensationByWorkerDate,
    range: { from: period.from, to: period.to }
  });
  decoratePayrollRows(report, workers, periodRests, filters, filteredSessions);

  return {
    ...report,
    period,
    filters,
    clients,
    workers,
    policiesByClientId,
    generatedAt: options.now || new Date()
  };
}

export function buildPayrollExportRows(report) {
  return report.rows.map((row) => {
    const restSummary = (row.restAssignments || []).map((rest) => {
      const reason = rest.reason ? ` ${rest.reason}` : '';
      const origin = rest.originSundayDate ? ` domingo:${rest.originSundayDate}` : '';
      return `${rest.restDate}${reason}${origin}`;
    }).join(' | ');
    const base = {
      Documento: row.documentNumber || '',
      TipoDocumento: row.documentType || '',
      Nombre: row.fullName,
      FechaInicial: report.period.from,
      FechaFinal: report.period.to,
      DiasTrabajados: row.workedDays || 0,
      DiasDescontados: row.deductedDays || 0,
      DiasLaboradosNetos: Number(row.netWorkedDays || 0),
      Descansos: restSummary,
      HorasOrdinarias: row.ordinaryHours,
      TotalTrabajado: row.totalHours,
      HorasExtraTotal: row.overtimeHours,
      Estado: row.status,
      Novedades: row.novelties.map((item) => `${item.dateKey || ''} ${item.code}`).join(' | ')
    };
    for (const code of PAYROLL_CONCEPT_CODES) base[code] = row.conceptHours[code];
    return base;
  });
}
