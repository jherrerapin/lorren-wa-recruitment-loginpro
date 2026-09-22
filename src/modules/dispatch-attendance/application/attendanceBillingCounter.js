import { dispatchServiceDateKey } from '../../../services/dispatchDate.js';

const BOGOTA_TIME_ZONE = 'America/Bogota';
export const ATTENDANCE_BILLING_CUT_DAY = 8;
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';

export const ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE = 'DISPATCH_ATTENDANCE_BILLING_CONFIG';
export const ATTENDANCE_BILLING_CONFIG_ENTITY_ID = 'GLOBAL';
export const ATTENDANCE_BILLING_CONFIG_ACTION = 'ATTENDANCE_BILLING_START_DATE_UPDATED';

function normalizeString(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function validDateKey(value) {
  const normalized = normalizeString(value, 10);
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
    ? normalized
    : null;
}

function requireDateKey(value, code = 'attendance_billing_start_date_invalid') {
  const dateKey = validDateKey(value);
  if (!dateKey) throw new Error(code);
  return dateKey;
}

export function attendanceBillingDateKeyInBogota(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error('attendance_billing_now_invalid');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOGOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function monthCutKey(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, ATTENDANCE_BILLING_CUT_DAY)).toISOString().slice(0, 10);
}

function shiftedRegularCycleStartKey(startKey, offsetMonths) {
  const [year, month] = startKey.split('-').map(Number);
  return monthCutKey(year, month - 1 + offsetMonths);
}

function regularCycleStartKey(todayKey) {
  const [year, month, day] = todayKey.split('-').map(Number);
  return day >= ATTENDANCE_BILLING_CUT_DAY
    ? monthCutKey(year, month - 1)
    : monthCutKey(year, month - 2);
}

function firstCycleEndExclusiveKey(startKey) {
  const [year, month, day] = startKey.split('-').map(Number);
  return day < ATTENDANCE_BILLING_CUT_DAY
    ? monthCutKey(year, month - 1)
    : monthCutKey(year, month);
}

function previousDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function formatCycleDate(dateKey) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(new Date(`${dateKey}T12:00:00.000Z`)).replace('.', '');
}

function normalizeDocument(value) {
  const normalized = normalizeString(value, 120);
  if (!normalized) return null;
  const canonical = normalized
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return canonical || null;
}

function workerIdentityKey(worker, fallbackWorkerId) {
  const documentNumber = normalizeDocument(worker?.documentNumber);
  if (documentNumber) return `document:${documentNumber}`;
  const workerId = normalizeString(worker?.id || fallbackWorkerId, 160);
  return workerId ? `worker:${workerId}` : null;
}

function cycleStatus(todayKey, startKey, endExclusiveKey) {
  if (todayKey < startKey) return 'UPCOMING';
  if (todayKey >= endExclusiveKey) return 'CLOSED';
  return 'OPEN';
}

function cycleView({ todayKey, billingStartDate, start, endExclusive }) {
  const end = previousDateKey(endExclusive);
  const status = cycleStatus(todayKey, start, endExclusive);
  const effectiveTo = status === 'UPCOMING' ? null : (todayKey < end ? todayKey : end);
  return {
    start,
    end,
    endExclusive,
    paymentDate: endExclusive,
    nextCycleStart: endExclusive,
    effectiveTo,
    status,
    isInitialCycle: start === billingStartDate,
    label: `${formatCycleDate(start)} – ${formatCycleDate(end)}`
  };
}

function configuredStartDateFromEvent(event) {
  const metadata = event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
  return validDateKey(metadata.billingStartDate)
    || validDateKey(event?.toValue?.billingStartDate)
    || null;
}

function environmentStartDate(env = process.env) {
  const raw = normalizeString(env?.ATTENDANCE_BILLING_START_DATE, 10);
  if (!raw) return null;
  return requireDateKey(raw);
}

export async function loadAttendanceBillingSettings(prisma, input = {}) {
  const today = attendanceBillingDateKeyInBogota(input.now || new Date());
  const explicitStartDate = input.billingStartDate === undefined
    ? null
    : requireDateKey(input.billingStartDate);
  if (explicitStartDate) {
    return {
      billingStartDate: explicitStartDate,
      configured: true,
      source: 'INPUT',
      configuredAt: null,
      today,
      cutDay: ATTENDANCE_BILLING_CUT_DAY,
      paymentDay: ATTENDANCE_BILLING_CUT_DAY
    };
  }

  let event = null;
  if (prisma?.devAuditEvent && typeof prisma.devAuditEvent.findFirst === 'function') {
    event = await prisma.devAuditEvent.findFirst({
      where: {
        entityType: ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE,
        entityId: ATTENDANCE_BILLING_CONFIG_ENTITY_ID,
        action: ATTENDANCE_BILLING_CONFIG_ACTION
      },
      orderBy: { createdAt: 'desc' }
    });
  }
  const persisted = configuredStartDateFromEvent(event);
  if (persisted) {
    return {
      billingStartDate: persisted,
      configured: true,
      source: 'PERSISTED',
      configuredAt: event?.createdAt || null,
      today,
      cutDay: ATTENDANCE_BILLING_CUT_DAY,
      paymentDay: ATTENDANCE_BILLING_CUT_DAY
    };
  }

  const fallback = environmentStartDate(input.env || process.env);
  return {
    billingStartDate: fallback,
    configured: Boolean(fallback),
    source: fallback ? 'ENVIRONMENT' : 'UNCONFIGURED',
    configuredAt: null,
    today,
    cutDay: ATTENDANCE_BILLING_CUT_DAY,
    paymentDay: ATTENDANCE_BILLING_CUT_DAY
  };
}

export async function saveAttendanceBillingStartDate(prisma, input = {}) {
  if (!prisma?.devAuditEvent
    || typeof prisma.devAuditEvent.findFirst !== 'function'
    || typeof prisma.devAuditEvent.create !== 'function') {
    throw new Error('attendance_billing_config_prisma_contract_invalid');
  }
  const billingStartDate = requireDateKey(input.billingStartDate);
  const previous = await prisma.devAuditEvent.findFirst({
    where: {
      entityType: ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE,
      entityId: ATTENDANCE_BILLING_CONFIG_ENTITY_ID,
      action: ATTENDANCE_BILLING_CONFIG_ACTION
    },
    orderBy: { createdAt: 'desc' }
  });
  const previousBillingStartDate = configuredStartDateFromEvent(previous);
  if (previousBillingStartDate === billingStartDate) {
    return { billingStartDate, previousBillingStartDate, changed: false };
  }

  await prisma.devAuditEvent.create({
    data: {
      entityType: ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE,
      entityId: ATTENDANCE_BILLING_CONFIG_ENTITY_ID,
      entityLabel: 'Inicio oficial del contador de asistencia',
      action: ATTENDANCE_BILLING_CONFIG_ACTION,
      actorUsername: normalizeString(input.actorUsername, 160),
      actorRole: normalizeString(input.actorRole, 80),
      actorSource: 'attendance-admin-billing',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      ...(previousBillingStartDate ? { fromValue: { billingStartDate: previousBillingStartDate } } : {}),
      toValue: { billingStartDate },
      metadata: {
        billingStartDate,
        previousBillingStartDate,
        cutDay: ATTENDANCE_BILLING_CUT_DAY,
        paymentDay: ATTENDANCE_BILLING_CUT_DAY
      }
    }
  });
  return { billingStartDate, previousBillingStartDate, changed: true };
}

export function resolveAttendanceBillingCycle(input = {}) {
  const todayKey = attendanceBillingDateKeyInBogota(input.now || new Date());
  const billingStartDate = requireDateKey(input.billingStartDate);
  const offset = Number.isInteger(input.cycleOffset) ? input.cycleOffset : 0;
  if (![0, -1].includes(offset)) throw new Error('attendance_billing_cycle_offset_invalid');

  const firstEndExclusive = firstCycleEndExclusiveKey(billingStartDate);
  if (todayKey < firstEndExclusive) {
    if (offset === -1) return null;
    return cycleView({
      todayKey,
      billingStartDate,
      start: billingStartDate,
      endExclusive: firstEndExclusive
    });
  }

  const currentStart = regularCycleStartKey(todayKey);
  if (offset === 0) {
    return cycleView({
      todayKey,
      billingStartDate,
      start: currentStart,
      endExclusive: shiftedRegularCycleStartKey(currentStart, 1)
    });
  }

  const previousRegularStart = shiftedRegularCycleStartKey(currentStart, -1);
  const previousStart = previousRegularStart < billingStartDate
    ? billingStartDate
    : previousRegularStart;
  if (previousStart >= currentStart) return null;
  return cycleView({
    todayKey,
    billingStartDate,
    start: previousStart,
    endExclusive: currentStart
  });
}

function requireBillingPrisma(prisma) {
  if (!prisma?.dispatchAssignment || typeof prisma.dispatchAssignment.findMany !== 'function') {
    throw new Error('attendance_billing_assignment_prisma_contract_invalid');
  }
  return prisma;
}

function createWorkerSummary(assignment, serviceDateKey) {
  const worker = assignment.worker || {};
  return {
    identityKey: workerIdentityKey(worker, assignment.workerId),
    workerIds: new Set([worker.id || assignment.workerId].filter(Boolean)),
    fullName: normalizeString(worker.fullName, 240) || 'Auxiliar sin nombre',
    documentType: normalizeString(worker.documentType, 40),
    documentNumber: normalizeString(worker.documentNumber, 120),
    firstServiceDate: serviceDateKey,
    lastServiceDate: serviceDateKey,
    serviceDays: new Set([serviceDateKey]),
    assignments: 1,
    attendanceManaged: Boolean(assignment.attendanceSession),
    confirmedAbsenceManaged: assignment.status === CONFIRMED_ASSIGNMENT_STATUS && !assignment.attendanceSession
  };
}

function mergeWorkerSummary(target, assignment, serviceDateKey) {
  const workerId = assignment.worker?.id || assignment.workerId;
  if (workerId) target.workerIds.add(workerId);
  if (serviceDateKey < target.firstServiceDate) target.firstServiceDate = serviceDateKey;
  if (serviceDateKey > target.lastServiceDate) target.lastServiceDate = serviceDateKey;
  target.serviceDays.add(serviceDateKey);
  target.assignments += 1;
  target.attendanceManaged = target.attendanceManaged || Boolean(assignment.attendanceSession);
  target.confirmedAbsenceManaged = target.confirmedAbsenceManaged
    || (assignment.status === CONFIRMED_ASSIGNMENT_STATUS && !assignment.attendanceSession);
}

function publicWorkerSummary(summary) {
  return {
    fullName: summary.fullName,
    documentType: summary.documentType,
    documentNumber: summary.documentNumber,
    firstServiceDate: summary.firstServiceDate,
    lastServiceDate: summary.lastServiceDate,
    serviceDays: summary.serviceDays.size,
    assignments: summary.assignments,
    reason: summary.attendanceManaged ? 'ATTENDANCE' : 'CONFIRMED_ABSENCE',
    reasonLabel: summary.attendanceManaged ? 'Asistencia gestionada' : 'Ausencia programada',
    duplicateWorkerRecords: summary.workerIds.size > 1
  };
}

export async function loadAttendanceBillingCounter(prisma, input = {}) {
  requireBillingPrisma(prisma);
  const settings = input.settings || await loadAttendanceBillingSettings(prisma, input);
  if (!settings.billingStartDate) return null;
  const cycle = resolveAttendanceBillingCycle({
    ...input,
    billingStartDate: settings.billingStartDate
  });
  if (!cycle) return null;
  if (!cycle.effectiveTo) return { ...cycle, count: 0, workers: [] };

  const assignments = await prisma.dispatchAssignment.findMany({
    where: {
      serviceRequest: {
        serviceDate: {
          gte: new Date(`${cycle.start}T00:00:00.000Z`),
          lt: new Date(`${cycle.endExclusive}T00:00:00.000Z`)
        }
      }
    },
    select: {
      id: true,
      workerId: true,
      status: true,
      worker: {
        select: {
          id: true,
          fullName: true,
          documentType: true,
          documentNumber: true,
          isTestProfile: true
        }
      },
      serviceRequest: { select: { serviceDate: true } },
      attendanceSession: { select: { id: true } }
    }
  });

  const byIdentity = new Map();
  for (const assignment of assignments) {
    if (!assignment?.worker || assignment.worker.isTestProfile === true) continue;
    const serviceDateKey = dispatchServiceDateKey(assignment.serviceRequest?.serviceDate);
    if (!serviceDateKey || serviceDateKey < cycle.start || serviceDateKey > cycle.effectiveTo) continue;

    const wasManagedByAttendance = Boolean(assignment.attendanceSession);
    const wasConfirmedForService = assignment.status === CONFIRMED_ASSIGNMENT_STATUS;
    if (!wasManagedByAttendance && !wasConfirmedForService) continue;

    const identityKey = workerIdentityKey(assignment.worker, assignment.workerId);
    if (!identityKey) continue;
    const existing = byIdentity.get(identityKey);
    if (existing) mergeWorkerSummary(existing, assignment, serviceDateKey);
    else byIdentity.set(identityKey, createWorkerSummary(assignment, serviceDateKey));
  }

  const workers = [...byIdentity.values()]
    .map(publicWorkerSummary)
    .sort((left, right) => (
      left.fullName.localeCompare(right.fullName, 'es')
      || String(left.documentNumber || '').localeCompare(String(right.documentNumber || ''), 'es')
    ));

  return { ...cycle, count: workers.length, workers };
}

export async function loadAttendanceBillingCounters(prisma, input = {}) {
  requireBillingPrisma(prisma);
  const settings = await loadAttendanceBillingSettings(prisma, input);
  if (!settings.billingStartDate) return { settings, current: null, previous: null };
  const current = await loadAttendanceBillingCounter(prisma, {
    ...input,
    settings,
    billingStartDate: settings.billingStartDate,
    cycleOffset: 0
  });
  const previous = await loadAttendanceBillingCounter(prisma, {
    ...input,
    settings,
    billingStartDate: settings.billingStartDate,
    cycleOffset: -1
  });
  return { settings, current, previous };
}
