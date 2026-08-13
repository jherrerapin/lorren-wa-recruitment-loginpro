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

function buildWindowItem({ phone, link, window, worker, now }) {
  const assignment = link?.assignment || null;
  const selectedWorker = assignment?.worker || worker || null;
  const lastInboundAt = window?.lastInboundAt ? new Date(window.lastInboundAt) : null;
  const expiresAt = lastInboundAt ? new Date(lastInboundAt.getTime() + DISPATCH_WHATSAPP_WINDOW_MS) : null;
  const isOpen = Boolean(expiresAt && now.getTime() < expiresAt.getTime());
  return {
    phone,
    workerId: selectedWorker?.id || null,
    workerName: text(selectedWorker?.fullName) || null,
    assignmentId: assignment?.id || null,
    serviceRequestId: assignment?.serviceRequestId || link?.serviceRequestId || null,
    sentAt: link?.createdAt ? new Date(link.createdAt).toISOString() : null,
    outboundStatus: text(link?.status) || null,
    providerMessageId: text(link?.providerMessageId) || null,
    lastInboundAt: lastInboundAt ? lastInboundAt.toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    isOpen,
    windowStatus: isOpen ? 'ABIERTA' : (lastInboundAt ? 'VENCIDA' : 'NO_ABIERTA'),
    remainingMs: isOpen ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0,
    responseEvidence: text(link?.confirmationMessageId) || null,
    responseReceivedAt: link?.confirmationReceivedAt ? new Date(link.confirmationReceivedAt).toISOString() : null
  };
}

export async function loadDispatchWhatsappTodayWindowMonitor({ prismaClient, now = new Date() } = {}) {
  if (!prismaClient) throw new Error('prismaClient es requerido');
  const dateKey = todayIsoDateCO(now);
  const { start, end } = bogotaDayRange(dateKey);

  const [windows, confirmationLinks, workers] = await Promise.all([
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
    }),
    prismaClient.dispatchWorker.findMany({
      select: { id: true, fullName: true, phone: true, createdAt: true }
    })
  ]);

  const links = confirmationLinks.filter(isOperationalLink);
  const linksByPhone = latestByPhone(
    links,
    (link) => link.phone || link.assignment?.worker?.phone,
    (link) => link.createdAt
  );
  const windowsByPhone = latestByPhone(windows, (window) => window.phone, (window) => window.lastInboundAt);
  const workersByPhone = latestByPhone(workers, (worker) => worker.phone, (worker) => worker.createdAt);
  const phones = new Set([...linksByPhone.keys(), ...windowsByPhone.keys()]);

  const items = [...phones]
    .map((phone) => buildWindowItem({
      phone,
      link: linksByPhone.get(phone) || null,
      window: windowsByPhone.get(phone) || null,
      worker: workersByPhone.get(phone) || null,
      now
    }))
    .sort((a, b) => {
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      const aTime = new Date(a.lastInboundAt || a.sentAt || 0).getTime();
      const bTime = new Date(b.lastInboundAt || b.sentAt || 0).getTime();
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
      inboundToday: windowsByPhone.size,
      assignmentsSentToday: linksByPhone.size
    },
    scope: 'operational',
    note: 'Solo muestra actividad operativa de hoy. No mezcla el monitor del bot de Reclutamiento ni registros DEV_TEST.'
  };
}
