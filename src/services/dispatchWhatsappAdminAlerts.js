import { prisma } from '../lib/prisma.js';
import { dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import {
  ACTIVE_LINK_STATUSES,
  normalizeDispatchWhatsappPhone
} from './dispatchWhatsappCloudConfig.js';
import { sendDispatchWhatsappTextMessage } from './dispatchWhatsappCloudClient.js';

export const DISPATCH_WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
// 30 seconds of safety margin lets the worker warn while at least ~20 minutes remain.
export const DISPATCH_WINDOW_REMINDER_LEAD_MS = (20 * 60 * 1000) + (30 * 1000);

function inboundReceivedAt(message = {}) {
  const timestamp = Number(message.timestamp || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();
}

export async function recordDispatchWhatsappInboundWindow({ scope = 'operational', message = {}, prismaClient = prisma } = {}) {
  const phone = normalizeDispatchWhatsappPhone(message.from);
  if (!phone) return null;
  const receivedAt = inboundReceivedAt(message);
  const key = { scope_phone: { scope, phone } };
  const current = await prismaClient.dispatchWhatsappContactWindow.findUnique({ where: key });
  if (current && new Date(current.lastInboundAt).getTime() >= receivedAt.getTime()) return current;
  if (current) {
    return prismaClient.dispatchWhatsappContactWindow.update({ where: key, data: { lastInboundAt: receivedAt } });
  }
  try {
    return await prismaClient.dispatchWhatsappContactWindow.create({ data: { scope, phone, lastInboundAt: receivedAt } });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    await prismaClient.dispatchWhatsappContactWindow.updateMany({
      where: { scope, phone, lastInboundAt: { lt: receivedAt } },
      data: { lastInboundAt: receivedAt }
    });
    return prismaClient.dispatchWhatsappContactWindow.findUnique({ where: key });
  }
}

export async function getDispatchWhatsappContactWindowStatus({ scope = 'operational', phone, now = new Date(), prismaClient = prisma } = {}) {
  const normalizedPhone = normalizeDispatchWhatsappPhone(phone);
  if (!normalizedPhone) return { isOpen: false, phone: '', lastInboundAt: null, expiresAt: null };
  const row = await prismaClient.dispatchWhatsappContactWindow.findUnique({
    where: { scope_phone: { scope, phone: normalizedPhone } }
  });
  if (!row?.lastInboundAt) return { isOpen: false, phone: normalizedPhone, lastInboundAt: null, expiresAt: null };
  const lastInboundAt = new Date(row.lastInboundAt);
  const expiresAt = new Date(lastInboundAt.getTime() + DISPATCH_WHATSAPP_WINDOW_MS);
  return { isOpen: now.getTime() < expiresAt.getTime(), phone: normalizedPhone, lastInboundAt, expiresAt };
}

function dateLabel(value) {
  const key = dispatchServiceDateKey(value);
  if (!key) return 'fecha por confirmar';
  const [year, month, day] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

function declineAlertText(assignment) {
  const request = assignment?.serviceRequest || {};
  const name = assignment?.worker?.fullName || 'Un auxiliar';
  const operation = request.operationPointName || request.serviceName || 'la operación asignada';
  return `⚠️ Novedad de despacho\n${name} indicó *NO PUEDO* para la asignación del ${dateLabel(request.serviceDate)} en ${operation}. Revisa la solicitud para asignar un reemplazo.`;
}

function reminderAlertText(assignment) {
  const name = assignment?.worker?.fullName || 'el auxiliar';
  const phone = normalizeDispatchWhatsappPhone(assignment?.worker?.phone) || 'sin número';
  return `⏰ La ventana de 24 horas con ${name} (${phone}) vence en aproximadamente 20 minutos. Si necesitas enviarle información sin plantilla, hazlo antes del vencimiento.`;
}

async function alertUserByUsername(prismaClient, username) {
  const normalized = String(username || '').trim();
  if (!normalized) return null;
  return prismaClient.appUser.findUnique({
    where: { username: normalized },
    select: {
      id: true,
      username: true,
      isActive: true,
      dispatchAlertPhone: true,
      dispatchWindowExpiryReminderEnabled: true
    }
  });
}

export async function sendDispatchDeclineAdminAlert({ scope = 'operational', link, assignment, prismaClient = prisma, axiosClient } = {}) {
  const ownerUsername = String(link?.alertOwnerUsername || assignment?.createdByUsername || '').trim();
  const user = await alertUserByUsername(prismaClient, ownerUsername);
  if (!user?.isActive || !user.dispatchAlertPhone) return { sent: false, reason: 'admin_alert_not_configured' };
  try {
    await sendDispatchWhatsappTextMessage({ scope, phone: user.dispatchAlertPhone, text: declineAlertText(assignment), axiosClient });
    return { sent: true, userId: user.id };
  } catch (error) {
    console.warn(`[dispatch-wa-cloud] No fue posible enviar alerta NO PUEDO al administrador ${user.username}: ${error?.message || error}`);
    return { sent: false, reason: 'provider_error', error: String(error?.message || error).slice(0, 300) };
  }
}

function eligibleServiceDate(assignment) {
  const key = dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate);
  return Boolean(key && key >= todayIsoDateCO());
}

export async function runDispatchWhatsappWindowReminderDispatcher(prismaClient = prisma, { now = new Date(), axiosClient } = {}) {
  const nowMs = now.getTime();
  const openAfter = new Date(nowMs - DISPATCH_WHATSAPP_WINDOW_MS);
  const reminderDueBefore = new Date(nowMs - (DISPATCH_WHATSAPP_WINDOW_MS - DISPATCH_WINDOW_REMINDER_LEAD_MS));
  const windows = await prismaClient.dispatchWhatsappContactWindow.findMany({
    where: { lastInboundAt: { gt: openAfter, lte: reminderDueBefore } },
    orderBy: { lastInboundAt: 'asc' },
    take: 100
  });
  let sent = 0;
  let failed = 0;

  for (const window of windows) {
    const links = await prismaClient.dispatchWhatsappConfirmation.findMany({
      where: {
        phone: window.phone,
        alertOwnerUsername: { not: null },
        status: { in: [...ACTIVE_LINK_STATUSES, 'CONFIRMED'] },
        createdAt: { gte: new Date(nowMs - (7 * 24 * 60 * 60 * 1000)) }
      },
      orderBy: { createdAt: 'desc' },
      include: { assignment: { include: { worker: true, serviceRequest: true } } }
    });
    const latestByOwner = new Map();
    for (const link of links) {
      if (!eligibleServiceDate(link.assignment)) continue;
      if (!latestByOwner.has(link.alertOwnerUsername)) latestByOwner.set(link.alertOwnerUsername, link);
    }

    for (const [ownerUsername, link] of latestByOwner.entries()) {
      const user = await alertUserByUsername(prismaClient, ownerUsername);
      if (!user?.isActive || !user.dispatchAlertPhone || !user.dispatchWindowExpiryReminderEnabled) continue;

      let reminder;
      try {
        reminder = await prismaClient.dispatchWhatsappWindowReminder.create({
          data: {
            scope: window.scope,
            phone: window.phone,
            appUserId: user.id,
            windowStartedAt: window.lastInboundAt,
            status: 'PENDING'
          }
        });
      } catch (error) {
        if (error?.code === 'P2002') continue;
        throw error;
      }

      try {
        await sendDispatchWhatsappTextMessage({
          scope: window.scope,
          phone: user.dispatchAlertPhone,
          text: reminderAlertText(link.assignment),
          axiosClient
        });
        await prismaClient.dispatchWhatsappWindowReminder.update({
          where: { id: reminder.id },
          data: { status: 'SENT', sentAt: new Date(), lastError: null }
        });
        sent += 1;
      } catch (error) {
        await prismaClient.dispatchWhatsappWindowReminder.update({
          where: { id: reminder.id },
          data: { status: 'FAILED', lastError: String(error?.message || error).slice(0, 400) }
        });
        failed += 1;
        console.warn(`[dispatch-wa-cloud] Falló recordatorio de ventana para ${user.username}: ${error?.message || error}`);
      }
    }
  }
  return { windowsChecked: windows.length, sent, failed };
}
