import { buildDispatchServiceDateWhere, dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import { DISPATCH_WHATSAPP_WINDOW_MS } from './dispatchWhatsappAdminAlerts.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMATION_SENDABLE_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING'];

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

function latestBy(rows, keySelector, timeSelector) {
  const result = new Map();
  for (const row of rows) {
    const key = keySelector(row);
    if (!key) continue;
    const previous = result.get(key);
    const rowTime = new Date(timeSelector(row) || 0).getTime();
    const previousTime = previous ? new Date(timeSelector(previous) || 0).getTime() : -1;
    if (!previous || rowTime >= previousTime) result.set(key, row);
  }
  return result;
}

function windowSnapshot(row, now) {
  const lastInboundAt = row?.lastInboundAt ? new Date(row.lastInboundAt) : null;
  const expiresAt = lastInboundAt ? new Date(lastInboundAt.getTime() + DISPATCH_WHATSAPP_WINDOW_MS) : null;
  const isOpen = Boolean(expiresAt && now.getTime() < expiresAt.getTime());
  return {
    isOpen,
    windowStatus: isOpen ? 'ABIERTA' : 'CERRADA',
    lastInboundAt: lastInboundAt ? lastInboundAt.toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    remainingMs: isOpen ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0
  };
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

  const windows = phones.length
    ? await prismaClient.dispatchWhatsappContactWindow.findMany({
        where: { scope: 'operational', phone: { in: phones } }
      })
    : [];
  const windowsByPhone = new Map(windows.map((row) => [normalizePhone(row.phone), row]));

  return Object.fromEntries(normalizedAssignments
    .filter((assignment) => assignment?.id)
    .map((assignment) => {
      const phone = normalizePhone(assignment?.worker?.phone);
      return [assignment.id, {
        assignmentId: assignment.id,
        phone,
        ...windowSnapshot(windowsByPhone.get(phone), now)
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

  const assignmentIds = assignments.map((assignment) => assignment.id);
  const links = assignmentIds.length
    ? await prismaClient.dispatchWhatsappConfirmation.findMany({
        where: { assignmentId: { in: assignmentIds } },
        orderBy: { createdAt: 'desc' }
      })
    : [];
  const latestLinkByAssignment = latestBy(links, (link) => link.assignmentId, (link) => link.createdAt);
  const windowsByAssignment = await loadDispatchWhatsappWindowStatusForAssignments({ prismaClient, assignments, now });

  const items = assignments.map((assignment) => {
    const worker = assignment.worker || {};
    const request = assignment.serviceRequest || {};
    const phone = normalizePhone(worker.phone);
    const window = windowsByAssignment[assignment.id] || windowSnapshot(null, now);
    const link = latestLinkByAssignment.get(assignment.id) || null;
    const confirmed = assignment.status === 'CONFIRMED';
    return {
      assignmentId: assignment.id,
      serviceRequestId: assignment.serviceRequestId,
      workerId: assignment.workerId,
      workerName: text(worker.fullName) || 'Auxiliar',
      phone,
      assignmentStatus: assignment.status,
      confirmed,
      canSendConfirmation: Boolean(phone && CONFIRMATION_SENDABLE_STATUSES.includes(assignment.status)),
      canSendManualMessage: Boolean(phone && window.isOpen),
      operationName: text(request.operationPointName || request.serviceName) || 'Operación',
      clientName: text(request.clientName) || null,
      address: text(request.address) || null,
      startTime: text(request.startTime) || null,
      serviceDate: dateKey,
      lastConfirmationSentAt: link?.createdAt ? new Date(link.createdAt).toISOString() : null,
      lastConfirmationStatus: text(link?.status) || null,
      deliveryModeHint: window.isOpen ? 'SESSION_INTERACTIVE' : 'TEMPLATE_REQUIRED',
      ...window
    };
  }).sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
    if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1;
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
      confirmed: items.filter((item) => item.confirmed).length,
      pendingConfirmation: items.filter((item) => item.canSendConfirmation).length
    },
    scope: 'operational',
    note: 'Lista únicamente auxiliares con asignación activa para mañana. La ventana abierta se calcula con el último inbound operativo + 24 horas y no usa datos del Monitor bot de Reclutamiento.'
  };
}
