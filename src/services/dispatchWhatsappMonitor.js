import { buildDispatchServiceDateWhere, dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import { DISPATCH_WHATSAPP_WINDOW_MS } from './dispatchWhatsappAdminAlerts.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const UNMATCHED_INBOUND_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  const digits = phoneDigits(value);
  if (!digits) return '';
  return digits.length === 10 ? `57${digits}` : digits;
}

function phoneIssue(value) {
  const digits = phoneDigits(value);
  if (!digits) return 'MISSING';
  if (digits.startsWith('57') && digits.length !== 12) return 'CO_LENGTH_MISMATCH';
  return null;
}

function addIsoDays(dateKey, days) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function latestDate(...values) {
  return values
    .map(validDate)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;
}

function windowSnapshot(lastInboundValue, now, evidenceSource = null) {
  const lastInboundAt = validDate(lastInboundValue);
  const expiresAt = lastInboundAt ? new Date(lastInboundAt.getTime() + DISPATCH_WHATSAPP_WINDOW_MS) : null;
  const isOpen = Boolean(expiresAt && now.getTime() < expiresAt.getTime());
  return {
    isOpen,
    windowStatus: isOpen ? 'ABIERTA' : 'CERRADA',
    lastInboundAt: lastInboundAt ? lastInboundAt.toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    remainingMs: isOpen ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0,
    evidenceSource
  };
}

function latestConfirmationEvidenceByPhone(rows = []) {
  const result = new Map();
  for (const row of rows) {
    const phone = normalizePhone(row?.phone);
    const receivedAt = validDate(row?.confirmationReceivedAt);
    if (!phone || !receivedAt) continue;
    const previous = result.get(phone);
    if (!previous || receivedAt.getTime() > previous.getTime()) result.set(phone, receivedAt);
  }
  return result;
}

async function healContactWindowFromEvidence({ prismaClient, phone, currentLastInboundAt, evidenceLastInboundAt }) {
  if (!phone || !evidenceLastInboundAt) return;
  const current = validDate(currentLastInboundAt);
  if (current && current.getTime() >= evidenceLastInboundAt.getTime()) return;
  await prismaClient.dispatchWhatsappContactWindow.upsert({
    where: { scope_phone: { scope: 'operational', phone } },
    create: { scope: 'operational', phone, lastInboundAt: evidenceLastInboundAt },
    update: { lastInboundAt: evidenceLastInboundAt }
  }).catch(() => {});
}

function possibleInboundMatch(phone, unmatchedInbound = []) {
  const digits = normalizePhone(phone);
  if (digits.length < 7) return null;
  const suffix = digits.slice(-7);
  const matches = unmatchedInbound.filter((item) => normalizePhone(item.phone).endsWith(suffix));
  return matches.length === 1 ? matches[0] : null;
}

export function tomorrowIsoDateCO(now = new Date()) {
  return addIsoDays(todayIsoDateCO(now), 1);
}

export async function loadDispatchWhatsappWindowStatusForAssignments({
  prismaClient,
  assignments = [],
  now = new Date()
} = {}) {
  if (!prismaClient) throw new Error('prismaClient es requerido');
  const normalizedAssignments = Array.isArray(assignments) ? assignments : [];
  const phones = [...new Set(normalizedAssignments
    .map((assignment) => normalizePhone(assignment?.worker?.phone))
    .filter(Boolean))];

  const [windows, confirmations] = phones.length
    ? await Promise.all([
        prismaClient.dispatchWhatsappContactWindow.findMany({
          where: { scope: 'operational', phone: { in: phones } }
        }),
        prismaClient.dispatchWhatsappConfirmation.findMany({
          where: { phone: { in: phones }, confirmationReceivedAt: { not: null } },
          select: { phone: true, confirmationReceivedAt: true },
          orderBy: { confirmationReceivedAt: 'desc' }
        })
      ])
    : [[], []];

  const windowsByPhone = new Map(windows.map((row) => [normalizePhone(row.phone), row]));
  const confirmationEvidenceByPhone = latestConfirmationEvidenceByPhone(confirmations);
  const snapshotsByPhone = new Map();

  for (const phone of phones) {
    const windowRow = windowsByPhone.get(phone);
    const contactInbound = validDate(windowRow?.lastInboundAt);
    const confirmationInbound = confirmationEvidenceByPhone.get(phone) || null;
    const effectiveInbound = latestDate(contactInbound, confirmationInbound);
    const source = effectiveInbound
      ? (confirmationInbound && (!contactInbound || confirmationInbound.getTime() > contactInbound.getTime())
          ? 'CONFIRMATION_EVIDENCE'
          : 'CONTACT_WINDOW')
      : null;

    if (source === 'CONFIRMATION_EVIDENCE') {
      await healContactWindowFromEvidence({
        prismaClient,
        phone,
        currentLastInboundAt: contactInbound,
        evidenceLastInboundAt: confirmationInbound
      });
    }
    snapshotsByPhone.set(phone, windowSnapshot(effectiveInbound, now, source));
  }

  return Object.fromEntries(normalizedAssignments
    .filter((assignment) => assignment?.id)
    .map((assignment) => {
      const phone = normalizePhone(assignment?.worker?.phone);
      return [assignment.id, {
        assignmentId: assignment.id,
        phone,
        ...windowSnapshot(null, now),
        ...(snapshotsByPhone.get(phone) || {})
      }];
    }));
}

export async function loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient, now = new Date() } = {}) {
  if (!prismaClient) throw new Error('prismaClient es requerido');
  const dateKey = tomorrowIsoDateCO(now);
  const assignmentsRaw = await prismaClient.dispatchAssignment.findMany({
    where: {
      status: { in: ACTIVE_ASSIGNMENT_STATUSES },
      serviceRequest: {
        source: { not: 'DEV_TEST' },
        ...buildDispatchServiceDateWhere(dateKey)
      }
    },
    include: { worker: true, serviceRequest: true },
    orderBy: { createdAt: 'asc' }
  });
  const assignments = assignmentsRaw.filter((assignment) => (
    assignment?.serviceRequest?.source !== 'DEV_TEST'
    && dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate) === dateKey
  ));

  const windowsByAssignment = await loadDispatchWhatsappWindowStatusForAssignments({ prismaClient, assignments, now });
  const assignedPhones = new Set(assignments.map((assignment) => normalizePhone(assignment?.worker?.phone)).filter(Boolean));
  const recentInboundRows = await prismaClient.dispatchWhatsappContactWindow.findMany({
    where: {
      scope: 'operational',
      lastInboundAt: { gte: new Date(now.getTime() - UNMATCHED_INBOUND_LOOKBACK_MS) }
    },
    orderBy: { lastInboundAt: 'desc' },
    take: 200
  });
  const unmatchedInbound = recentInboundRows
    .map((row) => ({
      phone: normalizePhone(row?.phone),
      lastInboundAt: validDate(row?.lastInboundAt)?.toISOString() || null
    }))
    .filter((row) => row.phone && row.lastInboundAt && !assignedPhones.has(row.phone));

  const items = assignments.map((assignment) => {
    const worker = assignment.worker || {};
    const request = assignment.serviceRequest || {};
    const phone = normalizePhone(worker.phone);
    const window = windowsByAssignment[assignment.id] || windowSnapshot(null, now);
    const possibleMatch = !window.isOpen ? possibleInboundMatch(phone, unmatchedInbound) : null;
    return {
      assignmentId: assignment.id,
      serviceRequestId: assignment.serviceRequestId,
      workerId: assignment.workerId,
      workerName: text(worker.fullName) || 'Auxiliar',
      phone,
      phoneIssue: phoneIssue(worker.phone),
      possibleInboundPhone: possibleMatch?.phone || null,
      possibleInboundAt: possibleMatch?.lastInboundAt || null,
      assignmentStatus: assignment.status,
      confirmed: assignment.status === 'CONFIRMED',
      canSendWindowCheck: Boolean(phone && !window.isOpen),
      canAttemptManualMessage: Boolean(phone),
      canSendManualMessage: Boolean(phone && window.isOpen),
      operationName: text(request.operationPointName || request.serviceName) || 'Operación',
      clientName: text(request.clientName) || null,
      address: text(request.address) || null,
      startTime: text(request.startTime) || null,
      serviceDate: dateKey,
      ...window
    };
  }).sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? 1 : -1;
    if (Boolean(a.phoneIssue || a.possibleInboundAt) !== Boolean(b.phoneIssue || b.possibleInboundAt)) {
      return a.phoneIssue || a.possibleInboundAt ? -1 : 1;
    }
    return a.workerName.localeCompare(b.workerName, 'es');
  });

  return {
    dateKey,
    generatedAt: now.toISOString(),
    items,
    unmatchedInbound,
    summary: {
      total: items.length,
      open: items.filter((item) => item.isOpen).length,
      closed: items.filter((item) => !item.isOpen).length,
      missingWindow: items.filter((item) => item.canSendWindowCheck).length,
      withoutPhone: items.filter((item) => !item.phone).length,
      phoneReview: items.filter((item) => item.phoneIssue || item.possibleInboundAt).length,
      unmatchedInbound: unmatchedInbound.length
    },
    scope: 'operational',
    note: 'Estado vivo: se recalcula en cada consulta con el último inbound operativo y, como respaldo, con confirmaciones persistidas. También expone inbound recientes que no coinciden con ningún teléfono de los asignados para detectar números mal registrados en lugar de marcarlos silenciosamente como cerrados.'
  };
}
