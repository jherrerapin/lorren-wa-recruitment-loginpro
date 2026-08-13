import { todayIsoDateCO } from './dispatchDate.js';
import { DISPATCH_WHATSAPP_WINDOW_MS } from './dispatchWhatsappAdminAlerts.js';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `57${digits}` : digits;
}

function bogotaDayRange(dateKey = todayIsoDateCO()) {
  return {
    start: new Date(`${dateKey}T00:00:00.000-05:00`),
    end: new Date(`${dateKey}T23:59:59.999-05:00`)
  };
}

function isOperationalLink(link) {
  return link?.assignment?.serviceRequest?.source !== 'DEV_TEST';
}

function latestByPhone(rows, phoneSelector, timeSelector) {
  const result = new Map();
  for (const row of rows) {
    const phone = normalizePhone(phoneSelector(row));
    if (!phone) continue;
    const previous = result.get(phone);
    const rowTime = new Date(timeSelector(row) || 0).getTime();
    const previousTime = previous ? new Date(timeSelector(previous) || 0).getTime() : -1;
    if (!previous || rowTime >= previousTime) result.set(phone, row);
  }
  return result;
}

function inboundAfterSend(window, link) {
  if (!window?.lastInboundAt || !link?.createdAt) return null;
  const inboundAt = new Date(window.lastInboundAt);
  const sentAt = new Date(link.createdAt);
  return inboundAt.getTime() >= sentAt.getTime() ? window : null;
}

function buildWindowItem({ phone, link, window, now }) {
  const assignment = link.assignment || null;
  const worker = assignment?.worker || null;
  const effectiveWindow = inboundAfterSend(window, link);
  const lastInboundAt = effectiveWindow?.lastInboundAt ? new Date(effectiveWindow.lastInboundAt) : null;
  const expiresAt = lastInboundAt ? new Date(lastInboundAt.getTime() + DISPATCH_WHATSAPP_WINDOW_MS) : null;
  const isOpen = Boolean(expiresAt && now.getTime() < expiresAt.getTime());
  return {
    phone,
    workerId: worker?.id || null,
    workerName: text(worker?.fullName) || null,
    assignmentId: assignment?.id || null,
    serviceRequestId: assignment?.serviceRequestId || link.serviceRequestId || null,
    sentAt: new Date(link.createdAt).toISOString(),
    outboundStatus: text(link.status) || null,
    providerMessageId: text(link.providerMessageId) || null,
    lastInboundAt: lastInboundAt ? lastInboundAt.toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    isOpen,
    windowStatus: isOpen ? 'ABIERTA' : (lastInboundAt ? 'VENCIDA' : 'NO_ABIERTA'),
    remainingMs: isOpen ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0,
    responseEvidence: text(link.confirmationMessageId) || null,
    responseReceivedAt: link.confirmationReceivedAt ? new Date(link.confirmationReceivedAt).toISOString() : null
  };
}

export async function loadDispatchWhatsappTodayWindowMonitor({ prismaClient, now = new Date() } = {}) {
  if (!prismaClient) throw new Error('prismaClient es requerido');
  const dateKey = todayIsoDateCO(now);
  const { start, end } = bogotaDayRange(dateKey);

  const [windows, confirmationLinks] = await Promise.all([
    prismaClient.dispatchWhatsappContactWindow.findMany({
      where: {
        scope: 'operational',
        lastInboundAt: { gte: start, lte: end }
      },
      orderBy: { lastInboundAt: 'desc' }
    }),
    prismaClient.dispatchWhatsappConfirmation.findMany({
      where: { createdAt: { gte: start, lte: end } },
      include: {
        assignment: {
          include: {
            worker: true,
            serviceRequest: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    })
  ]);

  const links = confirmationLinks.filter(isOperationalLink);
  const linksByPhone = latestByPhone(
    links,
    (link) => link.phone || link.assignment?.worker?.phone,
    (link) => link.createdAt
  );
  const windowsByPhone = latestByPhone(windows, (window) => window.phone, (window) => window.lastInboundAt);

  const items = [...linksByPhone.entries()]
    .map(([phone, link]) => buildWindowItem({ phone, link, window: windowsByPhone.get(phone) || null, now }))
    .sort((a, b) => {
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      const aTime = new Date(a.lastInboundAt || a.sentAt).getTime();
      const bTime = new Date(b.lastInboundAt || b.sentAt).getTime();
      return bTime - aTime;
    });

  return {
    dateKey,
    generatedAt: now.toISOString(),
    items,
    summary: {
      total: items.length,
      open: items.filter((item) => item.isOpen).length,
      notOpened: items.filter((item) => item.windowStatus === 'NO_ABIERTA').length,
      expired: items.filter((item) => item.windowStatus === 'VENCIDA').length,
      inboundAfterSend: items.filter((item) => item.lastInboundAt).length,
      assignmentsSentToday: linksByPhone.size
    },
    scope: 'operational',
    note: 'Solo toma auxiliares a quienes la línea operativa envió confirmación hoy. Una ventana cuenta como abierta únicamente si hubo un inbound posterior a ese envío; no mezcla el Monitor bot ni DEV_TEST.'
  };
}
