import { buildDispatchServiceDateWhere, dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import { DISPATCH_WHATSAPP_WINDOW_MS } from './dispatchWhatsappAdminAlerts.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `57${digits}` : digits;
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
        ...(snapshotsByPhone.get(phone) || windowSnapshot(null, now))
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

  const items = assignments.map((assignment) => {
    const worker = assignment.worker || {};
    const request = assignment.serviceRequest || {};
    const phone = normalizePhone(worker.phone);
    const window = windowsByAssignment[assignment.id] || windowSnapshot(null, now);
    return {
      assignmentId: assignment.id,
      serviceRequestId: assignment.serviceRequestId,
      workerId: assignment.workerId,
      workerName: text(worker.fullName) || 'Auxiliar',
      phone,
      assignmentStatus: assignment.status,
      confirmed: assignment.status === 'CONFIRMED',
      canSendWindowCheck: Boolean(phone && !window.isOpen),
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
    return a.workerName.localeCompare(b.workerName, 'es');
  });

  return {
    dateKey,
    generatedAt: now.toISOString(),
    items,
    summary: {
      total: items.length,
      open: items.filter((item) => item.isOpen).length,
      closed: items.filter((item) => !item.isOpen).length,
      missingWindow: items.filter((item) => item.canSendWindowCheck).length,
      withoutPhone: items.filter((item) => !item.phone).length
    },
    scope: 'operational',
    note: 'Estado vivo: se recalcula en cada consulta con el último inbound operativo y, como respaldo de integridad, con la evidencia persistida de confirmaciones recibidas. Ventana = último inbound + 24 horas.'
  };
}
