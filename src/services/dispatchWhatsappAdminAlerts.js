import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { buildDispatchServiceDateWhere, dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import {
  ACTIVE_DISPATCH_ASSIGNMENT_STATUSES,
  CONFIRMED_DISPATCH_ASSIGNMENT_STATUS,
  isOperationalDispatchWorker
} from './dispatchOperationalCoverage.js';
import { dispatchServiceRequestStartAt } from './dispatchServiceRequestPolicy.js';
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
const ASSIGNMENT_SEND_ATTEMPT_ACTION = 'SEND_ASSIGNMENT_CONFIRMATION_ATTEMPT';
const PENDING_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING'];
const AUTOMATION_MAX_ATTEMPTS_PER_DAY = 3;
const AUTOMATION_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const NOTIFICATION_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const WINDOW_EXPIRY_NOTIFICATION = 'WINDOW_EXPIRY_REMINDER';
const ALL_CONFIRMED_NOTIFICATION = 'ALL_ASSIGNMENTS_CONFIRMED';
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

export function buildDispatchWindowExpiryReminderText() {
  return '⏰ Tu ventana de WhatsApp con Despacho vence en aproximadamente 25 minutos. Si quieres mantenerla abierta, responde este mensaje; puede ser incluso con un punto (.).';
}

export function buildDispatchAllConfirmedAdminAlertText({ serviceDate, confirmedCount } = {}) {
  return `✅ Todos tus auxiliares asignados para el ${dateLabel(serviceDate)} ya confirmaron. Total confirmados: ${Number(confirmedCount || 0)}.`;
}

async function alertUserByUsername(prismaClient, username) {
  const normalized = String(username || '').trim();
  if (!normalized) return null;
  return prismaClient.appUser.findUnique({
    where: { username: normalized },
    select: { id: true, username: true, isActive: true, dispatchAlertPhone: true }
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

function notificationKey(kind, parts = []) {
  const digest = createHash('sha256').update([kind, ...parts].join('|')).digest('hex');
  return `${kind.toLowerCase()}:${digest}`;
}

async function claimDispatchWhatsappNotification(prismaClient, {
  scope,
  phone,
  notificationType,
  key,
  eventAt,
  now = new Date()
}) {
  try {
    return {
      claimed: true,
      row: await prismaClient.dispatchWhatsappNotification.create({
        data: { scope, phone, notificationType, notificationKey: key, eventAt, status: 'PENDING' }
      })
    };
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
  }
  const existing = await prismaClient.dispatchWhatsappNotification.findUnique({ where: { notificationKey: key } });
  if (!existing || existing.status !== 'FAILED') return { claimed: false, row: existing };
  const updatedAt = new Date(existing.updatedAt || existing.createdAt || Number.NaN);
  if (!Number.isNaN(updatedAt.getTime()) && now.getTime() - updatedAt.getTime() < NOTIFICATION_RETRY_COOLDOWN_MS) {
    return { claimed: false, row: existing };
  }
  const claimed = await prismaClient.dispatchWhatsappNotification.updateMany({
    where: { id: existing.id, status: 'FAILED' },
    data: { status: 'PENDING', lastError: null }
  });
  return { claimed: Boolean(claimed.count), row: existing };
}

async function markDispatchWhatsappNotification(prismaClient, rowId, { sent, error = null } = {}) {
  return prismaClient.dispatchWhatsappNotification.update({
    where: { id: rowId },
    data: sent
      ? { status: 'SENT', sentAt: new Date(), lastError: null }
      : { status: 'FAILED', lastError: String(error?.message || error || 'provider_error').slice(0, 400) }
  });
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
  return { assignmentAutoSendTime: normalizeDispatchAutomationTime(metadata.assignmentAutoSendTime) };
}

export async function loadDispatchWhatsappAutomationSettings({ prismaClient = prisma, userId } = {}) {
  const id = String(userId || '').trim();
  if (!id || !prismaClient?.devAuditEvent?.findFirst) return { assignmentAutoSendTime: null };
  const row = await prismaClient.devAuditEvent.findFirst({
    where: { entityType: AUTOMATION_CONFIG_ENTITY, entityId: id, action: AUTOMATION_CONFIG_ACTION },
    orderBy: { createdAt: 'desc' }
  });
  return automationMetadata(row);
}

export async function saveDispatchWhatsappAutomationSettings({
  prismaClient = prisma,
  userId,
  assignmentAutoSendTime = null
} = {}) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('userId es requerido');
  const normalizedAssignmentTime = normalizeDispatchAutomationTime(assignmentAutoSendTime);
  await prismaClient.devAuditEvent.create({
    data: {
      entityType: AUTOMATION_CONFIG_ENTITY,
      entityId: id,
      action: AUTOMATION_CONFIG_ACTION,
      actorUserId: id,
      actorSource: 'dispatch-whatsapp-settings',
      metadata: { assignmentAutoSendTime: normalizedAssignmentTime }
    }
  });
  return { assignmentAutoSendTime: normalizedAssignmentTime };
}

function bogotaClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: BOGOTA_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, timeKey: `${parts.hour}:${parts.minute}` };
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

function configurationPredatesCurrentDay(settings, currentDateKey) {
  const configuredAt = new Date(settings?.configuredAt || Number.NaN);
  if (Number.isNaN(configuredAt.getTime())) return false;
  return configuredAt.getTime() < bogotaDayStart(currentDateKey).getTime();
}

function isRecoverableAssignment(assignment, targetDateKey, now) {
  const createdAt = new Date(assignment?.createdAt || Number.NaN);
  if (Number.isNaN(createdAt.getTime())) return false;
  if (createdAt.getTime() >= bogotaDayStart(targetDateKey).getTime()) return false;
  const startAt = dispatchServiceRequestStartAt(assignment?.serviceRequest || {});
  return Boolean(startAt && now.getTime() < startAt.getTime());
}

async function latestAutomationConfigs(prismaClient) {
  if (!prismaClient?.devAuditEvent?.findMany) return [];
  const rows = await prismaClient.devAuditEvent.findMany({
    where: { entityType: AUTOMATION_CONFIG_ENTITY, action: AUTOMATION_CONFIG_ACTION },
    orderBy: { createdAt: 'desc' }
  });
  const latestByUserId = new Map();
  for (const row of rows) {
    const userId = String(row?.entityId || '').trim();
    if (!userId || latestByUserId.has(userId)) continue;
    latestByUserId.set(userId, { ...automationMetadata(row), configuredAt: row?.createdAt || null });
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
      serviceRequest: { source: { not: 'DEV_TEST' }, ...buildDispatchServiceDateWhere(dateKey) }
    },
    include: { worker: true, serviceRequest: true },
    orderBy: { createdAt: 'asc' }
  });
  return rows.filter((assignment) => (
    assignment?.serviceRequest?.source !== 'DEV_TEST'
    && dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate) === dateKey
    && isOperationalDispatchWorker(assignment?.worker)
  ));
}

function assignmentRunMarkerId(userId, dateKey, assignmentId) {
  return `${userId}:${dateKey}:assignment:${assignmentId}`;
}

function confirmationBlocksAutomaticSend(status) {
  return status === 'CONFIRMED' || ACTIVE_LINK_STATUSES.includes(String(status || ''));
}

async function loadAssignmentSendStates(prismaClient, userId, assignmentIds, dateKey, now) {
  const ids = [...new Set(assignmentIds.filter(Boolean))];
  const states = new Map(ids.map((assignmentId) => [assignmentId, { due: true, reason: null, failedAttempts: 0, latestFailureAt: null }]));
  if (!ids.length) return states;
  const markerToAssignment = new Map(ids.map((assignmentId) => [assignmentRunMarkerId(userId, dateKey, assignmentId), assignmentId]));
  const [confirmations, attempts] = await Promise.all([
    prismaClient.dispatchWhatsappConfirmation.findMany({
      where: { assignmentId: { in: ids } }, select: { assignmentId: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' }
    }),
    prismaClient.devAuditEvent.findMany({
      where: { entityType: AUTOMATION_RUN_ENTITY, action: ASSIGNMENT_SEND_ATTEMPT_ACTION, entityId: { in: [...markerToAssignment.keys()] } },
      select: { entityId: true, metadata: true, createdAt: true }, orderBy: { createdAt: 'desc' }
    })
  ]);
  for (const row of confirmations) {
    if (!confirmationBlocksAutomaticSend(row?.status)) continue;
    const state = states.get(row.assignmentId);
    if (state) { state.due = false; state.reason = 'already_sent'; }
  }
  for (const row of attempts) {
    const assignmentId = markerToAssignment.get(String(row?.entityId || ''));
    const state = states.get(assignmentId);
    if (!state) continue;
    const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    if (metadata.sent) { state.due = false; state.reason = 'already_sent'; continue; }
    if (!metadata.failed) continue;
    state.failedAttempts += 1;
    const failedAt = new Date(row?.createdAt || Number.NaN);
    if (!Number.isNaN(failedAt.getTime()) && (!state.latestFailureAt || failedAt > state.latestFailureAt)) state.latestFailureAt = failedAt;
  }
  for (const state of states.values()) {
    if (!state.due) continue;
    if (state.failedAttempts >= AUTOMATION_MAX_ATTEMPTS_PER_DAY) { state.due = false; state.reason = 'retry_exhausted'; continue; }
    if (state.latestFailureAt && now.getTime() - state.latestFailureAt.getTime() < AUTOMATION_RETRY_COOLDOWN_MS) {
      state.due = false; state.reason = 'retry_cooldown';
    }
  }
  return states;
}

async function recordAssignmentSendAttempt(prismaClient, {
  userId, dateKey, targetDateKey, assignmentId, sent = false, failed = false, errorCode = null, now = new Date()
}) {
  await prismaClient.devAuditEvent.create({
    data: {
      entityType: AUTOMATION_RUN_ENTITY,
      entityId: assignmentRunMarkerId(userId, dateKey, assignmentId),
      action: ASSIGNMENT_SEND_ATTEMPT_ACTION,
      actorUserId: userId,
      actorSource: 'dispatch-whatsapp-scheduler',
      metadata: { dateKey, targetDateKey, sent: Boolean(sent), failed: Boolean(failed), errorCode: errorCode ? String(errorCode).slice(0, 100) : null },
      createdAt: now
    }
  });
}

async function runAutomaticAssignmentSends({
  prismaClient, user, dateKey, targetDateKey, axiosClient, sendAssignmentMessage, recoveryMode = false, now = new Date()
}) {
  const runKey = `${user.id}:${dateKey}:${ASSIGNMENT_SEND_ATTEMPT_ACTION}`;
  if (activeScheduleRuns.has(runKey)) return { skipped: true, reason: 'running', eligible: 0, attempted: 0, sent: 0, failed: 0 };
  activeScheduleRuns.add(runKey);
  try {
    const assignments = await assignmentsForUserAndDate(prismaClient, user, targetDateKey, PENDING_ASSIGNMENT_STATUSES);
    const eligibleAssignments = recoveryMode ? assignments.filter((assignment) => isRecoverableAssignment(assignment, targetDateKey, now)) : assignments;
    const states = await loadAssignmentSendStates(prismaClient, user.id, eligibleAssignments.map((item) => item.id), dateKey, now);
    const pending = eligibleAssignments.filter((assignment) => states.get(assignment.id)?.due !== false);
    if (!pending.length) return { eligible: eligibleAssignments.length, attempted: 0, sent: 0, failed: 0 };
    const sender = sendAssignmentMessage || (await import('./dispatchWhatsappAssignmentService.js')).sendDispatchWhatsappMessage;
    let sent = 0;
    let failed = 0;
    for (const assignment of pending) {
      const phone = normalizeDispatchWhatsappPhone(assignment?.worker?.phone);
      if (!phone) {
        failed += 1;
        await recordAssignmentSendAttempt(prismaClient, { userId: user.id, dateKey, targetDateKey, assignmentId: assignment.id, failed: true, errorCode: 'phone_missing', now });
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
          scope: 'operational', actorUsername: user.username, prismaClient, axiosClient
        });
        sent += 1;
        await recordAssignmentSendAttempt(prismaClient, { userId: user.id, dateKey, targetDateKey, assignmentId: assignment.id, sent: true, now });
      } catch (error) {
        failed += 1;
        await recordAssignmentSendAttempt(prismaClient, { userId: user.id, dateKey, targetDateKey, assignmentId: assignment.id, failed: true, errorCode: error?.code || 'provider_error', now });
        console.warn(`[dispatch-wa-schedule] Falló envío automático. userId=${user.id} assignment=${assignment.id} code=${error?.code || 'unknown'}.`);
      }
    }
    return { eligible: eligibleAssignments.length, attempted: pending.length, sent, failed };
  } finally {
    activeScheduleRuns.delete(runKey);
  }
}

export async function runDispatchUserAutomationScheduler(prismaClient = prisma, {
  now = new Date(), axiosClient, sendAssignmentMessage = null
} = {}) {
  const clock = bogotaClock(now);
  const targetDateKey = addIsoDays(clock.dateKey, 1);
  const recoveryScheduleDateKey = addIsoDays(clock.dateKey, -1);
  const recoveryTargetDateKey = clock.dateKey;
  const configured = await latestAutomationConfigs(prismaClient);
  const result = {
    usersChecked: configured.length,
    targetDateKey,
    recoveryTargetDateKey,
    assignmentAttempts: 0,
    assignmentSent: 0,
    assignmentFailed: 0,
    recoveryAssignmentAttempts: 0,
    recoveryAssignmentSent: 0,
    recoveryAssignmentFailed: 0
  };
  for (const { user, settings } of configured) {
    const recoveryAllowed = configurationPredatesCurrentDay(settings, clock.dateKey);
    if (settings.assignmentAutoSendTime && recoveryAllowed && clock.timeKey < settings.assignmentAutoSendTime) {
      const recovery = await runAutomaticAssignmentSends({
        prismaClient, user, dateKey: recoveryScheduleDateKey, targetDateKey: recoveryTargetDateKey,
        axiosClient, sendAssignmentMessage, recoveryMode: true, now
      });
      result.assignmentAttempts += recovery.attempted;
      result.assignmentSent += recovery.sent;
      result.assignmentFailed += recovery.failed;
      result.recoveryAssignmentAttempts += recovery.attempted;
      result.recoveryAssignmentSent += recovery.sent;
      result.recoveryAssignmentFailed += recovery.failed;
    }
    if (settings.assignmentAutoSendTime && clock.timeKey >= settings.assignmentAutoSendTime) {
      const auto = await runAutomaticAssignmentSends({
        prismaClient, user, dateKey: clock.dateKey, targetDateKey, axiosClient, sendAssignmentMessage, now
      });
      result.assignmentAttempts += auto.attempted;
      result.assignmentSent += auto.sent;
      result.assignmentFailed += auto.failed;
    }
  }
  return result;
}

export async function sendDispatchAllConfirmedAdminAlert({
  scope = 'operational', link, assignment, prismaClient = prisma, axiosClient, now = new Date()
} = {}) {
  if (scope !== 'operational') return { sent: false, reason: 'scope_not_operational' };
  const ownerUsername = String(link?.alertOwnerUsername || assignment?.createdByUsername || '').trim();
  const user = await alertUserByUsername(prismaClient, ownerUsername);
  if (!user?.isActive || !user.dispatchAlertPhone) return { sent: false, reason: 'admin_alert_not_configured' };
  const dateKey = dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate);
  if (!dateKey) return { sent: false, reason: 'service_date_missing' };
  const assignments = await assignmentsForUserAndDate(prismaClient, user, dateKey, ACTIVE_DISPATCH_ASSIGNMENT_STATUSES);
  if (!assignments.length) return { sent: false, reason: 'no_active_assignments' };
  if (assignments.some((item) => item.status !== CONFIRMED_DISPATCH_ASSIGNMENT_STATUS)) {
    return { sent: false, reason: 'pending_assignments', total: assignments.length };
  }
  const ids = assignments.map((item) => item.id).sort();
  const key = notificationKey(ALL_CONFIRMED_NOTIFICATION, [scope, user.id, dateKey, ...ids]);
  const claim = await claimDispatchWhatsappNotification(prismaClient, {
    scope,
    phone: user.dispatchAlertPhone,
    notificationType: ALL_CONFIRMED_NOTIFICATION,
    key,
    eventAt: now,
    now
  });
  if (!claim.claimed) return { sent: false, duplicate: true, reason: 'already_notified' };
  try {
    await sendDispatchWhatsappTextMessage({
      scope,
      phone: user.dispatchAlertPhone,
      text: buildDispatchAllConfirmedAdminAlertText({ serviceDate: dateKey, confirmedCount: assignments.length }),
      axiosClient
    });
    await markDispatchWhatsappNotification(prismaClient, claim.row.id, { sent: true });
    return { sent: true, userId: user.id, confirmedCount: assignments.length };
  } catch (error) {
    await markDispatchWhatsappNotification(prismaClient, claim.row.id, { sent: false, error }).catch(() => {});
    console.warn(`[dispatch-wa-cloud] Falló aviso de todos confirmados para ${user.username}: ${error?.message || error}`);
    return { sent: false, reason: 'provider_error', error: String(error?.message || error).slice(0, 300) };
  }
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
        status: { in: [...ACTIVE_LINK_STATUSES, 'CONFIRMED'] },
        createdAt: { gte: new Date(nowMs - (7 * 24 * 60 * 60 * 1000)) }
      },
      orderBy: { createdAt: 'desc' },
      include: { assignment: { include: { worker: true, serviceRequest: true } } }
    });
    if (!links.some((item) => eligibleServiceDate(item.assignment) && isOperationalDispatchWorker(item.assignment?.worker))) continue;
    const key = notificationKey(WINDOW_EXPIRY_NOTIFICATION, [window.scope, window.phone, new Date(window.lastInboundAt).toISOString()]);
    const claim = await claimDispatchWhatsappNotification(prismaClient, {
      scope: window.scope,
      phone: window.phone,
      notificationType: WINDOW_EXPIRY_NOTIFICATION,
      key,
      eventAt: window.lastInboundAt,
      now
    });
    if (!claim.claimed) continue;
    try {
      await sendDispatchWhatsappTextMessage({
        scope: window.scope,
        phone: window.phone,
        text: buildDispatchWindowExpiryReminderText(),
        axiosClient
      });
      await markDispatchWhatsappNotification(prismaClient, claim.row.id, { sent: true });
      sent += 1;
    } catch (error) {
      await markDispatchWhatsappNotification(prismaClient, claim.row.id, { sent: false, error }).catch(() => {});
      failed += 1;
      console.warn(`[dispatch-wa-cloud] Falló recordatorio de ventana al auxiliar: ${error?.message || error}`);
    }
  }
  await runDispatchUserAutomationScheduler(prismaClient, { now, axiosClient }).catch((error) =>
    console.warn('[DISPATCH_WHATSAPP_AUTOMATION_ERROR]', error?.message || error)
  );
  return { windowsChecked: windows.length, sent, failed };
}
