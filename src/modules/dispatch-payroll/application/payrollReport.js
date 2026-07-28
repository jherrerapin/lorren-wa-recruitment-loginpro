import {
  DEFAULT_PAYROLL_POLICY,
  PAYROLL_COMPENSATION_STATUS,
  PAYROLL_CONCEPT_CODES,
  addDateKeyDays,
  bogotaDayStart,
  calculatePayrollConceptReport,
  normalizePayrollPolicy,
  payrollWeekStartKey
} from '../domain/payrollConceptEngine.js';

export const PAYROLL_POLICY_ENTITY_TYPE = 'DISPATCH_PAYROLL_POLICY';
export const PAYROLL_POLICY_ACTION = 'PAYROLL_POLICY_UPDATED';
export const PAYROLL_COMPENSATION_ENTITY_TYPE = 'DISPATCH_PAYROLL_COMPENSATION';
export const PAYROLL_COMPENSATION_ACTION = 'PAYROLL_COMPENSATION_UPDATED';

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

function policyFromEvent(event) {
  const raw = event?.metadata?.policy;
  return normalizePayrollPolicy(raw && typeof raw === 'object' ? raw : {});
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
  uniqueIds.forEach((id) => { if (!map.has(id)) map.set(id, normalizePayrollPolicy(DEFAULT_PAYROLL_POLICY)); });
  return map;
}

export async function savePayrollPolicy(prisma, input = {}) {
  const actorRole = normalizeString(input.actorRole, 80)?.toLowerCase();
  if (actorRole !== 'dev') throw new Error('payroll_policy_dev_required');
  const clientId = normalizeString(input.clientId, 120);
  if (!clientId) throw new Error('payroll_policy_client_required');
  const client = await prisma.dispatchClient.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
  if (!client) throw new Error('payroll_policy_client_not_found');

  const policy = normalizePayrollPolicy({
    weeklyOrdinaryMinutes: Number(input.weeklyOrdinaryHours) * 60,
    dailyOrdinaryMinutes: Number(input.dailyOrdinaryHours) * 60,
    maxDailyOvertimeMinutes: Number(input.maxDailyOvertimeHours) * 60,
    maxWeeklyOvertimeMinutes: Number(input.maxWeeklyOvertimeHours) * 60,
    nightStartMinute: Number(input.nightStartHour) * 60,
    nightEndMinute: Number(input.nightEndHour) * 60,
    weekStartsOn: Number(input.weekStartsOn),
    restDay: Number(input.restDay),
    recognizeEarlyArrival: input.recognizeEarlyArrival === true,
    incompleteBreakPenaltyMinutes: Number(input.incompleteBreakPenaltyMinutes),
    holidaySundayPriority: input.holidaySundayPriority,
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

export async function loadPayrollCompensationMap(prisma, workerIds = [], range = {}) {
  const uniqueIds = [...new Set(workerIds.filter(Boolean))];
  const map = new Map();
  if (!uniqueIds.length) return map;
  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: PAYROLL_COMPENSATION_ENTITY_TYPE,
      action: PAYROLL_COMPENSATION_ACTION,
      metadata: { path: ['workerId'], array_contains: undefined }
    },
    orderBy: { createdAt: 'desc' }
  }).catch(() => prisma.devAuditEvent.findMany({
    where: { entityType: PAYROLL_COMPENSATION_ENTITY_TYPE, action: PAYROLL_COMPENSATION_ACTION },
    orderBy: { createdAt: 'desc' }
  }));

  const workerSet = new Set(uniqueIds);
  for (const event of events) {
    const workerId = normalizeString(event?.metadata?.workerId, 120);
    const dateKey = validDateKey(event?.metadata?.dateKey);
    const status = normalizeString(event?.metadata?.status, 40)?.toUpperCase();
    if (!workerId || !workerSet.has(workerId) || !dateKey || dateKey < range.from || dateKey > range.to) continue;
    if (!Object.values(PAYROLL_COMPENSATION_STATUS).includes(status)) continue;
    const key = `${workerId}|${dateKey}`;
    if (!map.has(key)) map.set(key, status);
  }
  return map;
}

export async function savePayrollCompensation(prisma, input = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const dateKey = validDateKey(input.dateKey);
  const status = normalizeString(input.status, 40)?.toUpperCase();
  if (!workerId || !dateKey || !Object.values(PAYROLL_COMPENSATION_STATUS).includes(status)) {
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

function normalizedFilters(query = {}) {
  return {
    clientId: normalizeString(query.clientId, 120) || '',
    operationPointId: normalizeString(query.operationPointId, 120) || '',
    workerId: normalizeString(query.workerId, 120) || '',
    search: normalizeString(query.search, 160) || ''
  };
}

function sessionMatchesFilters(session, filters) {
  const assignment = session?.assignment;
  const worker = assignment?.worker || {};
  const point = assignment?.serviceRequest?.operationPoint || {};
  if (filters.clientId && point.clientId !== filters.clientId) return false;
  if (filters.operationPointId && point.id !== filters.operationPointId) return false;
  if (filters.workerId && worker.id !== filters.workerId) return false;
  if (filters.search) {
    const haystack = [worker.fullName, worker.documentNumber, worker.phone].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}

export async function loadPayrollReport(prisma, query = {}, options = {}) {
  const period = resolvePayrollPeriod(query, options.now || new Date());
  const filters = normalizedFilters(query);
  const expandedFrom = addDateKeyDays(period.from, -6);
  const start = bogotaDayStart(expandedFrom);
  const end = bogotaDayStart(addDateKeyDays(period.to, 1));

  const [sessions, clients, workers] = await Promise.all([
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
      where: { isActive: true },
      include: { operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' }
    }),
    prisma.dispatchWorker.findMany({
      where: { operationalStatus: { not: 'ELIMINADO' } },
      select: { id: true, fullName: true, documentNumber: true },
      orderBy: { fullName: 'asc' }
    })
  ]);

  const filteredSessions = sessions.filter((session) => sessionMatchesFilters(session, filters));
  const clientIds = [...new Set(filteredSessions.map((session) => session.assignment?.serviceRequest?.operationPoint?.clientId).filter(Boolean))];
  const workerIds = [...new Set(filteredSessions.map((session) => session.assignment?.workerId).filter(Boolean))];
  const [policiesByClientId, compensationByWorkerDate] = await Promise.all([
    loadPayrollPolicies(prisma, clientIds),
    loadPayrollCompensationMap(prisma, workerIds, period)
  ]);

  const report = calculatePayrollConceptReport({
    sessions: filteredSessions,
    policiesByClientId,
    compensationByWorkerDate,
    range: { from: period.from, to: period.to }
  });

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
    const base = {
      Documento: row.documentNumber || '',
      TipoDocumento: row.documentType || '',
      Nombre: row.fullName,
      FechaInicial: report.period.from,
      FechaFinal: report.period.to,
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
