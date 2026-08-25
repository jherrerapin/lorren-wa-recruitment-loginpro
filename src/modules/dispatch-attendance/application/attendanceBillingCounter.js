import { dispatchServiceDateKey } from '../../../services/dispatchDate.js';

const BOGOTA_TIME_ZONE = 'America/Bogota';
const BILLING_CUT_DAY = 8;
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';

export const DEFAULT_ATTENDANCE_BILLING_START_DATE = '2026-09-08';

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

function dateKeyInBogota(now = new Date()) {
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

function monthStartKey(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, BILLING_CUT_DAY)).toISOString().slice(0, 10);
}

function shiftedCycleStartKey(startKey, offsetMonths) {
  const [year, month] = startKey.split('-').map(Number);
  return monthStartKey(year, month - 1 + offsetMonths);
}

function currentCycleStartKey(todayKey) {
  const [year, month, day] = todayKey.split('-').map(Number);
  return day >= BILLING_CUT_DAY
    ? monthStartKey(year, month - 1)
    : monthStartKey(year, month - 2);
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

export function resolveAttendanceBillingCycle(input = {}) {
  const todayKey = dateKeyInBogota(input.now || new Date());
  const billingStartDate = validDateKey(
    input.billingStartDate
      ?? process.env.ATTENDANCE_BILLING_START_DATE
      ?? DEFAULT_ATTENDANCE_BILLING_START_DATE
  );
  if (!billingStartDate) throw new Error('attendance_billing_start_date_invalid');
  if (!billingStartDate.endsWith(`-${String(BILLING_CUT_DAY).padStart(2, '0')}`)) {
    throw new Error('attendance_billing_start_date_cut_invalid');
  }

  const offset = Number.isInteger(input.cycleOffset) ? input.cycleOffset : 0;
  const baseStart = todayKey < billingStartDate ? billingStartDate : currentCycleStartKey(todayKey);
  const start = shiftedCycleStartKey(baseStart, offset);
  if (start < billingStartDate) return null;
  const endExclusive = shiftedCycleStartKey(start, 1);
  const end = previousDateKey(endExclusive);
  const status = cycleStatus(todayKey, start, endExclusive);
  const effectiveTo = status === 'UPCOMING' ? null : (todayKey < end ? todayKey : end);

  return {
    start,
    end,
    endExclusive,
    effectiveTo,
    status,
    label: `${formatCycleDate(start)} – ${formatCycleDate(end)}`
  };
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
  const cycle = resolveAttendanceBillingCycle(input);
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
  const current = await loadAttendanceBillingCounter(prisma, { ...input, cycleOffset: 0 });
  const previous = await loadAttendanceBillingCounter(prisma, { ...input, cycleOffset: -1 });
  return { current, previous };
}
