import { dispatchServiceDateKey } from '../../../services/dispatchDate.js';
import {
  ensureAttendanceBillingEligibilitySnapshots,
  loadAttendanceBillingEligibilitySnapshots
} from './attendanceBillingEligibility.js';

const BOGOTA_TIME_ZONE = 'America/Bogota';
export const ATTENDANCE_BILLING_CUT_DAY = 1;
export const ATTENDANCE_BILLING_PAYMENT_DAY = 15;

export const ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE = 'DISPATCH_ATTENDANCE_BILLING_CONFIG';
export const ATTENDANCE_BILLING_CONFIG_ENTITY_ID = 'GLOBAL';
export const ATTENDANCE_BILLING_CONFIG_ACTION = 'ATTENDANCE_BILLING_START_DATE_UPDATED';
export const ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE = 'DISPATCH_ATTENDANCE_BILLING_INVOICE';
export const ATTENDANCE_BILLING_INVOICE_ACTION = 'ATTENDANCE_BILLING_INVOICE_ISSUED';

const BILLING_TIERS = Object.freeze([
  Object.freeze({ min: 1, max: 50, unitPrice: 7500 }),
  Object.freeze({ min: 51, max: 100, unitPrice: 7000 }),
  Object.freeze({ min: 101, max: 200, unitPrice: 6500 }),
  Object.freeze({ min: 201, max: null, unitPrice: 6000 })
]);

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

function monthStartKey(value) {
  const key = requireDateKey(value, 'attendance_billing_date_invalid');
  return `${key.slice(0, 7)}-01`;
}

function shiftMonthStartKey(startKey, offsetMonths) {
  const [year, month] = monthStartKey(startKey).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + offsetMonths, 1)).toISOString().slice(0, 10);
}

function paymentDateForCut(endExclusiveKey) {
  const [year, month] = endExclusiveKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, ATTENDANCE_BILLING_PAYMENT_DAY)).toISOString().slice(0, 10);
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
    cutDate: endExclusive,
    paymentDate: paymentDateForCut(endExclusive),
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
      paymentDay: ATTENDANCE_BILLING_PAYMENT_DAY
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
      paymentDay: ATTENDANCE_BILLING_PAYMENT_DAY
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
    paymentDay: ATTENDANCE_BILLING_PAYMENT_DAY
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
        paymentDay: ATTENDANCE_BILLING_PAYMENT_DAY
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

  if (todayKey < billingStartDate) {
    if (offset === -1) return null;
    return cycleView({
      todayKey,
      billingStartDate,
      start: billingStartDate,
      endExclusive: shiftMonthStartKey(monthStartKey(billingStartDate), 1)
    });
  }

  const currentMonthStart = monthStartKey(todayKey);
  const currentStart = currentMonthStart < billingStartDate ? billingStartDate : currentMonthStart;
  if (offset === 0) {
    return cycleView({
      todayKey,
      billingStartDate,
      start: currentStart,
      endExclusive: shiftMonthStartKey(currentMonthStart, 1)
    });
  }

  if (currentMonthStart <= billingStartDate) return null;
  const previousMonthStart = shiftMonthStartKey(currentMonthStart, -1);
  const previousStart = previousMonthStart < billingStartDate ? billingStartDate : previousMonthStart;
  if (previousStart >= currentMonthStart) return null;
  return cycleView({
    todayKey,
    billingStartDate,
    start: previousStart,
    endExclusive: currentMonthStart
  });
}

function requireBillingPrisma(prisma) {
  if (!prisma?.dispatchAssignment || typeof prisma.dispatchAssignment.findMany !== 'function') {
    throw new Error('attendance_billing_assignment_prisma_contract_invalid');
  }
  return prisma;
}

function requireInvoicePrisma(prisma) {
  if (!prisma?.devAuditEvent
    || typeof prisma.devAuditEvent.findFirst !== 'function'
    || typeof prisma.devAuditEvent.findMany !== 'function'
    || typeof prisma.devAuditEvent.create !== 'function') {
    throw new Error('attendance_billing_invoice_prisma_contract_invalid');
  }
  return prisma;
}

function createWorkerSummary(snapshot) {
  return {
    identityKey: workerIdentityKey({ id: snapshot.workerId, documentNumber: snapshot.documentNumber }, snapshot.workerId),
    workerIds: new Set([snapshot.workerId].filter(Boolean)),
    fullName: snapshot.fullName || 'Auxiliar sin nombre',
    documentType: snapshot.documentType || null,
    documentNumber: snapshot.documentNumber || null,
    firstServiceDate: snapshot.serviceDate,
    lastServiceDate: snapshot.serviceDate,
    serviceDays: new Set([snapshot.serviceDate]),
    assignments: 1,
    lockedAtServiceStart: true
  };
}

function mergeWorkerSummary(target, snapshot) {
  if (snapshot.workerId) target.workerIds.add(snapshot.workerId);
  if (snapshot.serviceDate < target.firstServiceDate) target.firstServiceDate = snapshot.serviceDate;
  if (snapshot.serviceDate > target.lastServiceDate) target.lastServiceDate = snapshot.serviceDate;
  target.serviceDays.add(snapshot.serviceDate);
  target.assignments += 1;
  target.lockedAtServiceStart = true;
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
    reason: 'SERVICE_START_LOCKED',
    reasonLabel: 'Facturable desde hora de inicio',
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
      serviceRequestId: true,
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
      serviceRequest: {
        select: {
          id: true,
          serviceDate: true,
          startTime: true,
          operationPointId: true,
          operationPointName: true,
          operationPoint: { select: { id: true, name: true, attendanceEnabled: true } }
        }
      },
      attendanceSession: { select: { id: true } }
    }
  });

  const relevantAssignments = assignments.filter((assignment) => {
    if (!assignment?.worker || assignment.worker.isTestProfile === true) return false;
    const serviceDate = dispatchServiceDateKey(assignment.serviceRequest?.serviceDate);
    return Boolean(serviceDate && serviceDate >= cycle.start && serviceDate <= cycle.effectiveTo);
  });

  const eligibility = await ensureAttendanceBillingEligibilitySnapshots(prisma, relevantAssignments, {
    now: input.now || new Date(),
    readOnly: input.readOnly === true,
    actorSource: 'attendance-billing-counter'
  });

  const snapshots = await loadAttendanceBillingEligibilitySnapshots(prisma, {
    cycleStart: cycle.start,
    cycleEndExclusive: cycle.endExclusive
  });
  if (input.readOnly) {
    const persistedIds = new Set(snapshots.map((snapshot) => snapshot.assignmentId));
    for (const result of eligibility) {
      if (result.reason === 'preview_only' && result.snapshot && !persistedIds.has(result.snapshot.assignmentId)) snapshots.push(result.snapshot);
    }
  }

  const byIdentity = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot.serviceDate || snapshot.serviceDate < cycle.start || snapshot.serviceDate > cycle.effectiveTo) continue;
    const identityKey = workerIdentityKey({ id: snapshot.workerId, documentNumber: snapshot.documentNumber }, snapshot.workerId);
    if (!identityKey) continue;
    const existing = byIdentity.get(identityKey);
    if (existing) mergeWorkerSummary(existing, snapshot);
    else byIdentity.set(identityKey, createWorkerSummary(snapshot));
  }

  const workers = [...byIdentity.values()]
    .map(publicWorkerSummary)
    .sort((left, right) => (
      left.fullName.localeCompare(right.fullName, 'es')
      || String(left.documentNumber || '').localeCompare(String(right.documentNumber || ''), 'es')
    ));

  return { ...cycle, count: workers.length, workers };
}

export function attendanceBillingPriceForCount(value) {
  const count = Math.max(0, Number.parseInt(value, 10) || 0);
  if (!count) return { count: 0, unitPrice: 0, total: 0, currency: 'COP', tier: null };
  const tier = BILLING_TIERS.find((candidate) => count >= candidate.min && (candidate.max === null || count <= candidate.max));
  if (!tier) throw new Error('attendance_billing_price_tier_not_found');
  return {
    count,
    unitPrice: tier.unitPrice,
    total: count * tier.unitPrice,
    currency: 'COP',
    tier: { min: tier.min, max: tier.max }
  };
}

function invoiceNumberForCycle(cycleStart) {
  return `ASIS-${cycleStart.slice(0, 7).replace('-', '')}`;
}

function invoiceFromEvent(event) {
  const metadata = event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : null;
  if (!metadata || !validDateKey(metadata.cycleStart) || !validDateKey(metadata.cycleEnd)) return null;
  return {
    id: event.id,
    invoiceNumber: normalizeString(metadata.invoiceNumber, 80) || invoiceNumberForCycle(metadata.cycleStart),
    cycleStart: metadata.cycleStart,
    cycleEnd: metadata.cycleEnd,
    cutDate: validDateKey(metadata.cutDate) || metadata.cycleEnd,
    paymentDate: validDateKey(metadata.paymentDate) || paymentDateForCut(metadata.cycleEnd),
    count: Math.max(0, Number(metadata.count) || 0),
    unitPrice: Math.max(0, Number(metadata.unitPrice) || 0),
    total: Math.max(0, Number(metadata.total) || 0),
    currency: normalizeString(metadata.currency, 12) || 'COP',
    workers: Array.isArray(metadata.workers) ? metadata.workers : [],
    createdAt: event.createdAt || null
  };
}

export async function loadAttendanceBillingInvoices(prisma, input = {}) {
  requireInvoicePrisma(prisma);
  const take = Math.min(24, Math.max(1, Number.parseInt(input.take, 10) || 12));
  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE,
      action: ATTENDANCE_BILLING_INVOICE_ACTION
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take
  });
  return events.map(invoiceFromEvent).filter(Boolean);
}

export async function ensureAttendanceBillingInvoice(prisma, input = {}) {
  requireBillingPrisma(prisma);
  requireInvoicePrisma(prisma);
  const settings = input.settings || await loadAttendanceBillingSettings(prisma, input);
  if (!settings.billingStartDate) return { created: false, invoice: null, reason: 'billing_not_configured' };
  const previous = await loadAttendanceBillingCounter(prisma, {
    ...input,
    settings,
    billingStartDate: settings.billingStartDate,
    cycleOffset: -1
  });
  if (!previous || previous.status !== 'CLOSED') return { created: false, invoice: null, reason: 'no_closed_cycle' };

  const existing = await prisma.devAuditEvent.findFirst({
    where: {
      entityType: ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE,
      entityId: previous.start,
      action: ATTENDANCE_BILLING_INVOICE_ACTION
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });
  if (existing) return { created: false, invoice: invoiceFromEvent(existing), reason: 'already_issued' };

  const pricing = attendanceBillingPriceForCount(previous.count);
  const invoiceNumber = invoiceNumberForCycle(previous.start);
  const workers = previous.workers.map((worker) => ({
    fullName: worker.fullName,
    documentType: worker.documentType,
    documentNumber: worker.documentNumber,
    firstServiceDate: worker.firstServiceDate,
    lastServiceDate: worker.lastServiceDate,
    serviceDays: worker.serviceDays,
    assignments: worker.assignments,
    reason: worker.reason,
    reasonLabel: worker.reasonLabel
  }));
  const event = await prisma.devAuditEvent.create({
    data: {
      entityType: ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE,
      entityId: previous.start,
      entityLabel: `Factura ${invoiceNumber}`,
      action: ATTENDANCE_BILLING_INVOICE_ACTION,
      actorSource: 'attendance-billing-worker',
      metadata: {
        invoiceNumber,
        cycleStart: previous.start,
        cycleEnd: previous.endExclusive,
        cutDate: previous.cutDate,
        paymentDate: previous.paymentDate,
        count: pricing.count,
        unitPrice: pricing.unitPrice,
        total: pricing.total,
        currency: pricing.currency,
        tier: pricing.tier,
        workers
      }
    }
  });
  return { created: true, invoice: invoiceFromEvent(event), reason: 'issued' };
}

export async function loadAttendanceBillingCounters(prisma, input = {}) {
  requireBillingPrisma(prisma);
  const settings = await loadAttendanceBillingSettings(prisma, input);
  const invoices = prisma?.devAuditEvent?.findMany
    ? await loadAttendanceBillingInvoices(prisma, input)
    : [];
  if (!settings.billingStartDate) return { settings, current: null, previous: null, invoices };
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
  return { settings, current, previous, invoices };
}
