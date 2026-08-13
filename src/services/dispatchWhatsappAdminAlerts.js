import { prisma } from '../lib/prisma.js';
import { buildDispatchServiceDateWhere, dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import {
  ACTIVE_LINK_STATUSES,
  normalizeDispatchWhatsappPhone
} from './dispatchWhatsappCloudConfig.js';
import { sendDispatchWhatsappTextMessage } from './dispatchWhatsappCloudClient.js';

export const DISPATCH_WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
// Warn about 25 minutes early so normal worker jitter still leaves at least 20 minutes.
export const DISPATCH_WINDOW_REMINDER_LEAD_MS = 25 * 60 * 1000;

const BOGOTA_TIME_ZONE = 'America/Bogota';
const AUTOMATION_CONFIG_ENTITY = 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG';
const AUTOMATION_CONFIG_ACTION = 'SET_DISPATCH_WHATSAPP_AUTOMATION';
const AUTOMATION_RUN_ENTITY = 'DISPATCH_WHATSAPP_AUTOMATION_RUN';
const PENDING_ALERT_ACTION = 'SEND_PENDING_CONFIRMATION_ALERT';
const AUTOMATION_CONFIG_LIMIT = 1000;
const PENDING_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING'];
const MAX_PENDING_REPORT_ITEMS = 40;
const activeScheduleRuns = new Set();

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
  return new Intl.DateTimeFormat('es-CO', { timeZone: BOGOTA_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

export function buildDispatchNoveltyAdminAlertText(assignment) {
  const request = assignment?.serviceRequest || {};
  const name = assignment?.worker?.fullName || 'Un auxiliar';
  const phone = normalizeDispatchWhatsappPhone(assignment?.worker?.phone) || 'sin número';
  const operation = request.operationPointName || request.serviceName || 'la operación asignada';
  return `⚠️ Novedad reportada\n${name} (${phone}) reportó una novedad sobre su asignación del ${dateLabel(request.serviceDate)} en ${operation}.\nComunícate con el auxiliar para conocer qué ocurrió y gestionar lo necesario.`;
}

function reminderAlertText(assignment) {
  const name = assignment?.worker?.fullName || 'el auxiliar';
  const phone = normalizeDispatchWhatsappPhone(assignment?.worker?.phone) || 'sin número';
  return `⏰ La ventana de 24 horas con ${name} (${phone}) vence en aproximadamente 25 minutos. Si necesitas enviarle información sin plantilla, hazlo antes del vencimiento.`;
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

export async function sendDispatchNoveltyAdminAlert({ scope = 'operational', link, assignment, prismaClient = prisma, axiosClient } = {}) {
  const ownerUsername = String(link?.alertOwnerUsername || assignment?.createdByUsername || '').trim();
  const user = await alertUserByUsername(prismaClient, ownerUsername);
  if (!user?.isActive || !user.dispatchAlertPhone) return { sent: false, reason: 'admin_alert_not_configured' };
  try {
    await sendDispatchWhatsappTextMessage({ scope, phone: user.dispatchAlertPhone, text: buildDispatchNoveltyAdminAlertText(assignment), axiosClient });
    return { sent: true, userId: user.id };
  } catch (error) {
    console.warn(`[dispatch-wa-cloud] No fue posible enviar alerta de novedad al administrador ${user.username}: ${error?.message || error}`);
    return { sent: false, reason: 'provider_error', error: String(error?.message || error).slice(0, 300) };
  }
}

function eligibleServiceDate(assignment) {
  const key = dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate);
  return Boolean(key && key >= todayIsoDateCO());
}

export function normalizeDispatchAutomationTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : null;
}

function automationMetadata(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    assignmentAutoSendTime: normalizeDispatchAutomationTime(metadata.assignmentAutoSendTime),
    pendingConfirmationAlertTime: normalizeDispatchAutomationTime(metadata.pendingConfirmationAlertTime)
  };
}

export async function loadDispatchWhatsappAutomationSettings({ prismaClient = prisma, userId } = {}) {
  const id = String(userId || '').trim();
  if (!id || !prismaClient?.devAuditEvent?.findFirst) {
    return { assignmentAutoSendTime: null, pendingConfirmationAlertTime: null };
  }
  const row = await prismaClient.devAuditEvent.findFirst({
    where: {
      entityType: AUTOMATION_CONFIG_ENTITY,
      entityId: id,
      action: AUTOMATION_CONFIG_ACTION
    },
    orderBy: { createdAt: 'desc' }
  });
  return automationMetadata(row);
}

export async function saveDispatchWhatsappAutomationSettings({
  prismaClient = prisma,
  userId,
  assignmentAutoSendTime = null,
  pendingConfirmationAlertTime = null
} = {}) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('userId es requerido');
  const normalizedAssignmentTime = normalizeDispatchAutomationTime(assignmentAutoSendTime);
  const normalizedPendingTime = normalizeDispatchAutomationTime(pendingConfirmationAlertTime);
  await prismaClient.devAuditEvent.create({
    data: {
      entityType: AUTOMATION_CONFIG_ENTITY,
      entityId: id,
      action: AUTOMATION_CONFIG_ACTION,
      actorUserId: id,
      actorSource: 'dispatch-whatsapp-settings',
      metadata: {
        assignmentAutoSendTime: normalizedAssignmentTime,
        pendingConfirmationAlertTime: normalizedPendingTime
      }
    }
  });
  return {
    assignmentAutoSendTime: normalizedAssignmentTime,
    pendingConfirmationAlertTime: normalizedPendingTime
  };
}

function bogotaClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: BOGOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    timeKey: `${parts.hour}:${parts.minute}`
  };
}

function addIsoDays(dateKey, days) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

export function isDispatchBogotaScheduleDue(configuredTime, now = new Date()) {
  const normalized = normalizeDispatchAutomationTime(configuredTime);
  if (!normalized) return false;
  return bogotaClock(now).timeKey >= normalized;
}

function bogotaDayStart(dateKey) {
  return new Date(`${dateKey}T00:00:00.000-05:00`);
}

async function latestAutomationConfigs(prismaClient) {
  if (!prismaClient?.devAuditEvent?.findMany) return [];
  const rows = await prismaClient.devAuditEvent.findMany({
    where: { entityType: AUTOMATION_CONFIG_ENTITY, action: AUTOMATION_CONFIG_ACTION },
    orderBy: { createdAt: 'desc' },
    take: AUTOMATION_CONFIG_LIMIT
  });
  const latestByUserId = new Map();
  for (const row of rows) {
    const userId = String(row?.entityId || '').trim();
    if (!userId || latestByUserId.has(userId)) continue;
    latestByUserId.set(userId, automationMetadata(row));
  }
  if (!latestByUserId.size) return [];
  const users = await prismaClient.appUser.findMany({
    where: { id: { in: [...latestByUserId.keys()] }, isActive: true },
    select: { id: true, username: true, dispatchAlertPhone: true, isActive: true }
  });
  return users.map((user) => ({ user, settings: latestByUserId.get(user.id) || {} }));
}

async function assignmentsForUserAndDate(prismaClient, user, dateKey, statuses) {
  const rows = await prismaClient.dispatchAssignment.findMany({
    where: {
      createdByUsername: user.username,
      status: { in: statuses },
      serviceRequest: {
        source: { not: 'DEV_TEST' },
        ...buildDispatchServiceDateWhere(dateKey)
      }
    },
    include: { worker: true, serviceRequest: true },
    orderBy: { createdAt: 'asc' }
  });
  return rows.filter((assignment) => (
    assignment?.serviceRequest?.source !== 'DEV_TEST'
    && dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate) === dateKey
  ));
}

async function attemptedAssignmentIdsToday(prismaClient, assignmentIds, dateKey) {
  if (!assignmentIds.length) return new Set();
  const rows = await prismaClient.dispatchWhatsappConfirmation.findMany({
    where: {
      assignmentId: { in: assignmentIds },
      createdAt: { gte: bogotaDayStart(dateKey) }
    },
    select: { assignmentId: true }
  });
  return new Set(rows.map((row) => row.assignmentId).filter(Boolean));
}

export function buildDispatchPendingConfirmationAlertText(assignments = [], targetDateKey) {
  const pending = Array.isArray(assignments) ? assignments : [];
  const visible = pending.slice(0, MAX_PENDING_REPORT_ITEMS);
  const lines = visible.map((assignment, index) => {
    const name = String(assignment?.worker?.fullName || 'Auxiliar').trim() || 'Auxiliar';
    const phone = normalizeDispatchWhatsappPhone(assignment?.worker?.phone) || 'sin número';
    return `${index + 1}. ${name} — ${phone}`;
  });
  if (pending.length > visible.length) lines.push(`… y ${pending.length - visible.length} auxiliar(es) más.`);
  return `⏰ Auxiliares pendientes de confirmar para ${dateLabel(targetDateKey)}\n\n${lines.join('\n')}\n\nTotal pendientes: ${pending.length}. Comunícate con ellos para validar su asistencia.`;
}

function runMarkerId(userId, dateKey) {
  return `${userId}:${dateKey}`;
}

async function pendingAlertAlreadyRan(prismaClient, userId, dateKey) {
  return prismaClient.devAuditEvent.findFirst({
    where: {
      entityType: AUTOMATION_RUN_ENTITY,
      entityId: runMarkerId(userId, dateKey),
      action: PENDING_ALERT_ACTION
    },
    select: { id: true }
  });
}

async function recordPendingAlertRun(prismaClient, userId, dateKey, targetDateKey, summary) {
  await prismaClient.devAuditEvent.create({
    data: {
      entityType: AUTOMATION_RUN_ENTITY,
      entityId: runMarkerId(userId, dateKey),
      action: PENDING_ALERT_ACTION,
      actorUserId: userId,
      actorSource: 'dispatch-whatsapp-scheduler',
      metadata: {
        dateKey,
        targetDateKey,
        pendingCount: Number(summary?.pendingCount || 0),
        sent: Boolean(summary?.sent),
        failed: Boolean(summary?.failed)
      }
    }
  });
}

async function runAutomaticAssignmentSends({
  prismaClient,
  user,
  dateKey,
  targetDateKey,
  axiosClient,
  sendAssignmentMessage
}) {
  const assignments = await assignmentsForUserAndDate(prismaClient, user, targetDateKey, ['ASSIGNED']);
  const attempted = await attemptedAssignmentIdsToday(prismaClient, assignments.map((item) => item.id), dateKey);
  const pending = assignments.filter((assignment) => !attempted.has(assignment.id));
  if (!pending.length) return { eligible: assignments.length, attempted: 0, sent: 0, failed: 0 };

  const sender = sendAssignmentMessage || (await import('./dispatchWhatsappAssignmentService.js')).sendDispatchWhatsappMessage;
  let sent = 0;
  let failed = 0;
  for (const assignment of pending) {
    const phone = normalizeDispatchWhatsappPhone(assignment?.worker?.phone);
    if (!phone) {
      failed += 1;
      continue;
    }
    try {
      await sender({
        phone,
        context: {
          serviceRequestId: assignment.serviceRequestId,
          assignmentId: assignment.id,
          workerId: assignment.workerId,
          recipientName: assignment.worker?.fullName || null,
          messageType: 'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST'
        },
        scope: 'operational',
        actorUsername: user.username,
        prismaClient,
        axiosClient
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[dispatch-wa-schedule] Falló envío automático. userId=${user.id} assignment=${assignment.id} code=${error?.code || 'unknown'}.`);
    }
  }
  return { eligible: assignments.length, attempted: pending.length, sent, failed };
}

async function runPendingConfirmationAlert({
  prismaClient,
  user,
  dateKey,
  targetDateKey,
  axiosClient,
  sendAdminMessage
}) {
  const runKey = `${user.id}:${dateKey}:${PENDING_ALERT_ACTION}`;
  if (activeScheduleRuns.has(runKey)) return { skipped: true, reason: 'running' };
  if (await pendingAlertAlreadyRan(prismaClient, user.id, dateKey)) return { skipped: true, reason: 'already_ran' };
  if (!user.dispatchAlertPhone) return { skipped: true, reason: 'alert_phone_missing' };

  activeScheduleRuns.add(runKey);
  try {
    const assignments = await assignmentsForUserAndDate(prismaClient, user, targetDateKey, PENDING_ASSIGNMENT_STATUSES);
    const summary = { pendingCount: assignments.length, sent: false, failed: false };
    if (assignments.length) {
      try {
        await sendAdminMessage({
          scope: 'operational',
          phone: user.dispatchAlertPhone,
          text: buildDispatchPendingConfirmationAlertText(assignments, targetDateKey),
          axiosClient
        });
        summary.sent = true;
      } catch (error) {
        summary.failed = true;
        console.warn(`[dispatch-wa-schedule] Falló reporte de pendientes. userId=${user.id} code=${error?.code || 'provider_error'}.`);
      }
    }
    await recordPendingAlertRun(prismaClient, user.id, dateKey, targetDateKey, summary);
    return summary;
  } finally {
    activeScheduleRuns.delete(runKey);
  }
}

export async function runDispatchUserAutomationScheduler(prismaClient = prisma, {
  now = new Date(),
  axiosClient,
  sendAssignmentMessage = null,
  sendAdminMessage = sendDispatchWhatsappTextMessage
} = {}) {
  const clock = bogotaClock(now);
  const targetDateKey = addIsoDays(clock.dateKey, 1);
  const configured = await latestAutomationConfigs(prismaClient);
  const result = {
    usersChecked: configured.length,
    targetDateKey,
    assignmentAttempts: 0,
    assignmentSent: 0,
    assignmentFailed: 0,
    pendingAlertsSent: 0,
    pendingAlertsFailed: 0
  };

  for (const { user, settings } of configured) {
    if (settings.assignmentAutoSendTime && clock.timeKey >= settings.assignmentAutoSendTime) {
      const auto = await runAutomaticAssignmentSends({
        prismaClient,
        user,
        dateKey: clock.dateKey,
        targetDateKey,
        axiosClient,
        sendAssignmentMessage
      });
      result.assignmentAttempts += auto.attempted;
      result.assignmentSent += auto.sent;
      result.assignmentFailed += auto.failed;
    }

    if (settings.pendingConfirmationAlertTime && clock.timeKey >= settings.pendingConfirmationAlertTime) {
      const alert = await runPendingConfirmationAlert({
        prismaClient,
        user,
        dateKey: clock.dateKey,
        targetDateKey,
        axiosClient,
        sendAdminMessage
      });
      if (alert?.sent) result.pendingAlertsSent += 1;
      if (alert?.failed) result.pendingAlertsFailed += 1;
    }
  }
  return result;
}

export async function runDispatchWhatsappWindowReminderDispatcher(prismaClient = prisma, { now = new Date(), axiosClient } = {}) {
  await runDispatchUserAutomationScheduler(prismaClient, { now, axiosClient }).catch((error) =>
    console.warn('[DISPATCH_WHATSAPP_AUTOMATION_ERROR]', error?.message || error)
  );

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
