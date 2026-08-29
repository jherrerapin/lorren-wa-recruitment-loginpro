import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { resolveAttendanceFailureDecision } from '../modules/dispatch-attendance/application/adminAttendance.js';
import { buildDispatchServiceDateWhere, dispatchServiceDateKey } from './dispatchDate.js';
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
import {
  sendDispatchAttendanceFailureDecisionMessage,
  sendDispatchWhatsappTextMessage
} from './dispatchWhatsappCloudClient.js';

export const DISPATCH_WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
// Warn about 25 minutes early so normal worker jitter still leaves at least 20 minutes.
export const DISPATCH_WINDOW_REMINDER_LEAD_MS = 25 * 60 * 1000;

const BOGOTA_TIME_ZONE = 'America/Bogota';
const AUTOMATION_CONFIG_ENTITY = 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG';
const AUTOMATION_CONFIG_ACTION = 'SET_DISPATCH_WHATSAPP_AUTOMATION';
const AUTOMATION_RUN_ENTITY = 'DISPATCH_WHATSAPP_AUTOMATION_RUN';
const ASSIGNMENT_SEND_ATTEMPT_ACTION = 'SEND_ASSIGNMENT_CONFIRMATION_ATTEMPT';
const PENDING_ALERT_ACTION = 'SEND_PENDING_CONFIRMATION_ALERT';
const PENDING_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING'];
const MAX_PENDING_REPORT_ITEMS = 40;
const AUTOMATION_MAX_ATTEMPTS_PER_DAY = 3;
const AUTOMATION_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const NOTIFICATION_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const WINDOW_EXPIRY_NOTIFICATION = 'WINDOW_EXPIRY_REMINDER';
const ALL_CONFIRMED_NOTIFICATION = 'ALL_ASSIGNMENTS_CONFIRMED';
const ATTENDANCE_FAILURE_NOTIFICATION = 'ATTENDANCE_MARK_FAILURE_ALERT';
const ATTENDANCE_FAILURE_ENTITY = 'DISPATCH_ATTENDANCE_MARK_FAILURE';
const ATTENDANCE_FAILURE_ACTION = 'MARK_ATTEMPT_FAILED';
const ATTENDANCE_FAILURE_ALERT_THRESHOLD = 5;
const activeScheduleRuns = new Set();
const activeNotificationClaims = new Set();
const NOTIFICATION_ENTITY = 'DISPATCH_WHATSAPP_NOTIFICATION';

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

function dateTimeLabel(value) {
  const date = value instanceof Date ? value : new Date(value || Number.NaN);
  if (Number.isNaN(date.getTime())) return 'hora no disponible';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);
}

function attendanceMarkLabel(markType) {
  return ({
    ARRIVAL: 'la entrada',
    BREAK_START: 'el inicio de almuerzo',
    BREAK_END: 'el fin de almuerzo',
    DEPARTURE: 'la salida'
  })[String(markType || '').toUpperCase()] || 'una marcación';
}

function attendanceFailureMarkType(input = {}) {
  return String(input?.markType || '').trim().toUpperCase();
}

function attendanceFailureMoment(event) {
  const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const date = new Date(metadata.occurredAt || event?.createdAt || Number.NaN);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function assignmentHasAttendanceMark(assignment, markType) {
  const normalized = attendanceFailureMarkType({ markType });
  const session = assignment?.attendanceSession || null;
  if (!session || !normalized) return false;
  if (normalized === 'ARRIVAL' && session.arrivalReportedAt) return true;
  if (normalized === 'DEPARTURE' && session.departureReportedAt) return true;
  return (Array.isArray(session.marks) ? session.marks : []).some((mark) => (
    attendanceFailureMarkType(mark) === normalized
  ));
}

async function attendanceFailuresForMark(prismaClient, assignmentId, markType) {
  if (!assignmentId || !markType || typeof prismaClient?.devAuditEvent?.findMany !== 'function') return [];
  const events = await prismaClient.devAuditEvent.findMany({
    where: {
      entityType: ATTENDANCE_FAILURE_ENTITY,
      action: ATTENDANCE_FAILURE_ACTION,
      entityId: assignmentId
    },
    orderBy: { createdAt: 'desc' }
  });
  return events
    .filter((event) => {
      const metadata = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
      return event?.entityType === ATTENDANCE_FAILURE_ENTITY
        && event?.action === ATTENDANCE_FAILURE_ACTION
        && String(event?.entityId || '').trim() === assignmentId
        && attendanceFailureMarkType(metadata) === markType;
    })
    .sort((left, right) => attendanceFailureMoment(right).getTime() - attendanceFailureMoment(left).getTime());
}

async function latestAttendanceFailureForMark(prismaClient, assignmentId, markType) {
  return (await attendanceFailuresForMark(prismaClient, assignmentId, markType))[0] || null;
}

function attendanceFailureLocation(input = {}) {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const accuracyMeters = Number(input.accuracyMeters);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return {
    latitude,
    longitude,
    accuracyMeters: Number.isFinite(accuracyMeters) && accuracyMeters >= 0 ? accuracyMeters : null
  };
}

export function buildDispatchNoveltyAdminAlertText(assignment) {
  const request = assignment?.serviceRequest || {};
  const name = assignment?.worker?.fullName || 'Un auxiliar';
  const phone = normalizeDispatchWhatsappPhone(assignment?.worker?.phone) || 'sin número';
  const operation = request.operationPointName || request.serviceName || 'la operación asignada';
  return `⚠️ Novedad reportada\n${name} (${phone}) reportó una novedad sobre su asignación del ${dateLabel(request.serviceDate)} en ${operation}.\nComunícate con el auxiliar para conocer qué ocurrió y gestionar lo necesario.`;
}

export function buildDispatchAttendanceFailureAdminAlertText({ failureEvent, assignment, failureContext = {}, failureAttemptCount = 1 } = {}) {
  const metadata = failureEvent?.metadata && typeof failureEvent.metadata === 'object' ? failureEvent.metadata : {};
  const workerName = String(assignment?.worker?.fullName || 'Un auxiliar').trim() || 'Un auxiliar';
  const operation = assignment?.serviceRequest?.operationPointName
    || assignment?.serviceRequest?.serviceName
    || 'la operación asignada';
  const markType = metadata.markType || failureContext.markType;
  const occurredAt = metadata.occurredAt || failureContext.occurredAt || failureEvent?.createdAt;
  const description = String(metadata.descriptionEs || 'La marcación no pudo completarse.').trim();
  const normalizedAttemptCount = Math.max(1, Number(failureAttemptCount) || 1);
  const lines = [
    '⚠️ Marcación no completada',
    normalizedAttemptCount >= ATTENDANCE_FAILURE_ALERT_THRESHOLD
      ? `${workerName} acumuló ${normalizedAttemptCount} intentos fallidos al registrar ${attendanceMarkLabel(markType)}. El último fue el ${dateTimeLabel(occurredAt)} en ${operation}.`
      : `${workerName} tuvo un intento fallido al registrar ${attendanceMarkLabel(markType)} el ${dateTimeLabel(occurredAt)} en ${operation}.`,
    `Motivo inicial: ${description}`
  ];
  if (metadata.failureCode === 'outside_operation_range') {
    const location = attendanceFailureLocation(failureContext);
    if (location) {
      lines.push(`Ubicación del intento: https://www.google.com/maps?q=${location.latitude},${location.longitude}`);
      if (location.accuracyMeters !== null) lines.push(`Precisión reportada: ${Math.round(location.accuracyMeters)} m.`);
    } else {
      lines.push('Ubicación del intento: el dispositivo no entregó coordenadas válidas para mostrar en el mapa.');
    }
  }
  lines.push('Este aviso representa esa marcación, no cada intento. Si vuelve a fallar, los botones resolverán el último intento pendiente. Si finalmente logra marcar correctamente, no se modificará esa marcación.');
  return lines.join('\n');
}

export function buildDispatchWindowExpiryReminderText() {
  return '⏰ Tu ventana personal de WhatsApp para recibir alertas de Despacho vence en aproximadamente 25 minutos. Para mantenerla abierta, responde este mensaje; puede ser incluso con un punto (.).';
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

export async function sendDispatchAttendanceFailureAdminAlert({
  scope = 'operational',
  failureEvent,
  failureContext = {},
  prismaClient = prisma,
  axiosClient,
  sendDecisionMessage = sendDispatchAttendanceFailureDecisionMessage,
  now = new Date()
} = {}) {
  if (scope !== 'operational') return { sent: false, reason: 'scope_not_operational' };
  if (failureEvent?.entityType !== ATTENDANCE_FAILURE_ENTITY || failureEvent?.action !== ATTENDANCE_FAILURE_ACTION) {
    return { sent: false, reason: 'failure_event_invalid' };
  }
  const metadata = failureEvent.metadata && typeof failureEvent.metadata === 'object' ? failureEvent.metadata : {};
  const assignmentId = String(metadata.assignmentId || '').trim();
  const markType = attendanceFailureMarkType(metadata);
  if (!assignmentId) return { sent: false, reason: 'assignment_missing' };
  if (!markType) return { sent: false, reason: 'mark_type_missing' };
  const failures = await attendanceFailuresForMark(prismaClient, assignmentId, markType);
  if (failures.length < ATTENDANCE_FAILURE_ALERT_THRESHOLD) {
    return { sent: false, reason: 'failure_threshold_not_reached', failureCount: failures.length };
  }
  const latestFailure = failures[0] || failureEvent;
  const latestMetadata = latestFailure?.metadata && typeof latestFailure.metadata === 'object' ? latestFailure.metadata : {};
  const latestFailureContext = latestFailure.id === failureEvent.id
    ? failureContext
    : latestMetadata;
  const assignment = await prismaClient.dispatchAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      worker: true,
      serviceRequest: true,
      attendanceSession: {
        select: {
          arrivalReportedAt: true,
          departureReportedAt: true,
          marks: { select: { markType: true } }
        }
      }
    }
  });
  if (!assignment) return { sent: false, reason: 'assignment_missing' };
  if (assignmentHasAttendanceMark(assignment, markType)) {
    return {
      sent: false,
      reason: 'mark_already_recorded',
      failureCount: failures.length,
      assignmentId,
      markType
    };
  }
  const user = await alertUserByUsername(prismaClient, assignment.createdByUsername);
  if (!user?.isActive || !user.dispatchAlertPhone) return { sent: false, reason: 'admin_alert_not_configured' };
  const key = notificationKey(ATTENDANCE_FAILURE_NOTIFICATION, [scope, user.id, assignmentId, markType]);
  const claim = await claimDispatchWhatsappNotification(prismaClient, {
    notificationType: ATTENDANCE_FAILURE_NOTIFICATION,
    key,
    eventAt: latestFailure.createdAt || now,
    now
  });
  if (!claim.claimed) return { sent: false, duplicate: true, reason: claim.reason || 'already_notified' };
  try {
    const text = buildDispatchAttendanceFailureAdminAlertText({
      failureEvent: latestFailure,
      assignment,
      failureContext: latestFailureContext,
      failureAttemptCount: failures.length
    });
    const sent = await sendDecisionMessage({
      scope,
      phone: user.dispatchAlertPhone,
      failureEventId: latestFailure.id,
      text,
      axiosClient
    });
    await markDispatchWhatsappNotification(prismaClient, claim, { sent: true, now });
    return {
      sent: true,
      userId: user.id,
      failureCount: failures.length,
      failureEventId: latestFailure.id,
      providerMessageId: sent?.providerMessageId || null
    };
  } catch (error) {
    await markDispatchWhatsappNotification(prismaClient, claim, { sent: false, error, now }).catch(() => {});
    console.warn(`[dispatch-wa-cloud] Falló alerta de marcación al coordinador ${user.username}: ${error?.message || error}`);
    return { sent: false, reason: 'provider_error', error: String(error?.message || error).slice(0, 300) };
  }
}

export async function resolveDispatchAttendanceFailureCoordinatorDecision({
  scope = 'operational',
  failureEventId,
  decision,
  coordinatorPhone,
  decidedAt = new Date(),
  prismaClient = prisma,
  registerManualAttendanceFn
} = {}) {
  if (scope !== 'operational') return { handled: false, reason: 'scope_not_operational' };
  const eventId = String(failureEventId || '').trim();
  const normalizedDecision = String(decision || '').trim().toUpperCase();
  if (!/^attendance_failure_[a-f0-9]{48}$/.test(eventId) || !['ACCEPT', 'REJECT'].includes(normalizedDecision)) {
    return { handled: false, reason: 'decision_invalid' };
  }
  const failureEvent = await prismaClient.devAuditEvent.findUnique({ where: { id: eventId } });
  if (failureEvent?.entityType !== ATTENDANCE_FAILURE_ENTITY || failureEvent?.action !== ATTENDANCE_FAILURE_ACTION) {
    return { handled: false, reason: 'failure_not_found' };
  }
  const metadata = failureEvent.metadata && typeof failureEvent.metadata === 'object' ? failureEvent.metadata : {};
  const assignmentId = String(metadata.assignmentId || '').trim();
  const markType = attendanceFailureMarkType(metadata);
  if (!assignmentId || !markType) return { handled: false, reason: 'failure_context_invalid' };
  const assignment = await prismaClient.dispatchAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      createdByUsername: true,
      attendanceSession: {
        select: {
          arrivalReportedAt: true,
          departureReportedAt: true,
          marks: { select: { markType: true } }
        }
      }
    }
  });
  if (!assignment) return { handled: false, reason: 'assignment_missing' };
  const user = await alertUserByUsername(prismaClient, assignment.createdByUsername);
  const authorizedPhone = normalizeDispatchWhatsappPhone(user?.dispatchAlertPhone);
  if (!user?.isActive || !authorizedPhone || authorizedPhone !== normalizeDispatchWhatsappPhone(coordinatorPhone)) {
    return { handled: false, reason: 'coordinator_unauthorized' };
  }
  if (assignmentHasAttendanceMark(assignment, markType)) {
    return {
      handled: true,
      duplicate: true,
      alreadyRecorded: true,
      status: 'ACCEPTED',
      assignmentId,
      markType
    };
  }

  const latestFailure = await latestAttendanceFailureForMark(prismaClient, assignmentId, markType);
  const latestMetadata = latestFailure?.metadata && typeof latestFailure.metadata === 'object' ? latestFailure.metadata : {};
  if (
    normalizedDecision === 'ACCEPT'
    && latestFailure?.id
    && latestFailure.id !== eventId
    && latestMetadata.failureCode === 'outside_operation_range'
  ) {
    throw new Error('attendance_failure_decision_stale_gps_evidence');
  }
  const effectiveFailureEventId = latestFailure?.id || eventId;
  try {
    return await resolveAttendanceFailureDecision(prismaClient, {
      failureEventId: effectiveFailureEventId,
      decision: normalizedDecision,
      actorUserId: user.id,
      actorUsername: user.username,
      actorRole: 'coordinator',
      actorSource: 'dispatch-whatsapp',
      writerActorRole: 'coordinator-whatsapp',
      decidedAt,
      ...(typeof registerManualAttendanceFn === 'function' ? { registerManualAttendanceFn } : {})
    });
  } catch (error) {
    if (error?.message === 'attendance_failure_decision_not_found') {
      return { handled: false, reason: 'failure_not_found' };
    }
    if (error?.message === 'attendance_failure_decision_context_invalid') {
      return { handled: false, reason: 'failure_context_invalid' };
    }
    if (error?.message === 'attendance_failure_decision_assignment_not_found') {
      return { handled: false, reason: 'assignment_missing' };
    }
    throw error;
  }
}

function notificationKey(kind, parts = []) {
  const digest = createHash('sha256').update([kind, ...parts].join('|')).digest('hex');
  return `${kind.toLowerCase()}:${digest}`;
}

async function claimDispatchWhatsappNotification(prismaClient, {
  notificationType,
  key,
  eventAt,
  now = new Date()
}) {
  if (activeNotificationClaims.has(key)) return { claimed: false, reason: 'running' };
  activeNotificationClaims.add(key);
  try {
    const previous = await prismaClient.devAuditEvent.findFirst({
      where: { entityType: NOTIFICATION_ENTITY, entityId: key, action: notificationType },
      orderBy: { createdAt: 'desc' }
    });
    const metadata = previous?.metadata && typeof previous.metadata === 'object' ? previous.metadata : {};
    if (metadata.status === 'SENT') {
      activeNotificationClaims.delete(key);
      return { claimed: false, reason: 'already_sent' };
    }
    if (previous && ['PENDING', 'FAILED'].includes(metadata.status)) {
      const previousAt = new Date(previous.createdAt || Number.NaN);
      if (!Number.isNaN(previousAt.getTime()) && now.getTime() - previousAt.getTime() < NOTIFICATION_RETRY_COOLDOWN_MS) {
        activeNotificationClaims.delete(key);
        return { claimed: false, reason: 'retry_cooldown' };
      }
    }
    const row = await prismaClient.devAuditEvent.create({
      data: {
        entityType: NOTIFICATION_ENTITY,
        entityId: key,
        action: notificationType,
        actorSource: 'dispatch-whatsapp-notification',
        metadata: { status: 'PENDING', eventAt: new Date(eventAt || now).toISOString() },
        createdAt: now
      }
    });
    return { claimed: true, row, key, notificationType };
  } catch (error) {
    activeNotificationClaims.delete(key);
    throw error;
  }
}

async function markDispatchWhatsappNotification(prismaClient, claim, { sent, error = null, now = new Date() } = {}) {
  try {
    await prismaClient.devAuditEvent.create({
      data: {
        entityType: NOTIFICATION_ENTITY,
        entityId: claim.key,
        action: claim.notificationType,
        actorSource: 'dispatch-whatsapp-notification',
        metadata: {
          status: sent ? 'SENT' : 'FAILED',
          error: sent ? null : String(error?.message || error || 'provider_error').slice(0, 300)
        },
        createdAt: now
      }
    });
  } finally {
    activeNotificationClaims.delete(claim.key);
  }
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
    where: { entityType: AUTOMATION_CONFIG_ENTITY, entityId: id, action: AUTOMATION_CONFIG_ACTION },
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

async function pendingAlertRunState(prismaClient, userId, dateKey, now) {
  const rows = await prismaClient.devAuditEvent.findMany({
    where: {
      entityType: AUTOMATION_RUN_ENTITY,
      entityId: runMarkerId(userId, dateKey),
      action: PENDING_ALERT_ACTION
    },
    select: { metadata: true, createdAt: true },
    orderBy: { createdAt: 'desc' }
  });
  let failedAttempts = 0;
  let latestFailureAt = null;
  for (const row of rows) {
    const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const pendingCount = Number(metadata.pendingCount || 0);
    if (metadata.sent || (!metadata.failed && pendingCount === 0)) {
      return { due: false, reason: 'already_ran', failedAttempts, latestFailureAt };
    }
    if (!metadata.failed) continue;
    failedAttempts += 1;
    const failedAt = new Date(row?.createdAt || Number.NaN);
    if (!Number.isNaN(failedAt.getTime()) && (!latestFailureAt || failedAt > latestFailureAt)) latestFailureAt = failedAt;
  }
  if (failedAttempts >= AUTOMATION_MAX_ATTEMPTS_PER_DAY) {
    return { due: false, reason: 'retry_exhausted', failedAttempts, latestFailureAt };
  }
  if (latestFailureAt && now.getTime() - latestFailureAt.getTime() < AUTOMATION_RETRY_COOLDOWN_MS) {
    return { due: false, reason: 'retry_cooldown', failedAttempts, latestFailureAt };
  }
  return { due: true, reason: null, failedAttempts, latestFailureAt };
}

async function recordPendingAlertRun(prismaClient, userId, dateKey, targetDateKey, summary, now = new Date()) {
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
      },
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

async function runPendingConfirmationAlert({
  prismaClient,
  user,
  dateKey,
  targetDateKey,
  axiosClient,
  sendAdminMessage,
  recoveryMode = false,
  now = new Date()
}) {
  const runKey = `${user.id}:${dateKey}:${PENDING_ALERT_ACTION}`;
  if (activeScheduleRuns.has(runKey)) return { skipped: true, reason: 'running' };
  activeScheduleRuns.add(runKey);
  try {
    const runState = await pendingAlertRunState(prismaClient, user.id, dateKey, now);
    if (!runState.due) return { skipped: true, reason: runState.reason };
    if (!user.dispatchAlertPhone) return { skipped: true, reason: 'alert_phone_missing' };

    const assignments = await assignmentsForUserAndDate(prismaClient, user, targetDateKey, PENDING_ASSIGNMENT_STATUSES);
    const eligibleAssignments = recoveryMode
      ? assignments.filter((assignment) => isRecoverableAssignment(assignment, targetDateKey, now))
      : assignments;
    const summary = { pendingCount: eligibleAssignments.length, sent: false, failed: false };
    if (!eligibleAssignments.length) {
      await recordPendingAlertRun(prismaClient, user.id, dateKey, targetDateKey, summary, now);
      return summary;
    }

    try {
      await sendAdminMessage({
        scope: 'operational',
        phone: user.dispatchAlertPhone,
        text: buildDispatchPendingConfirmationAlertText(eligibleAssignments, targetDateKey),
        axiosClient
      });
      summary.sent = true;
    } catch (error) {
      summary.failed = true;
      console.warn(`[dispatch-wa-schedule] Falló reporte de pendientes. userId=${user.id} code=${error?.code || 'provider_error'}.`);
    }
    await recordPendingAlertRun(prismaClient, user.id, dateKey, targetDateKey, summary, now);
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
    pendingAlertsSent: 0,
    pendingAlertsFailed: 0,
    recoveryAssignmentAttempts: 0,
    recoveryAssignmentSent: 0,
    recoveryAssignmentFailed: 0,
    recoveryPendingAlertsSent: 0,
    recoveryPendingAlertsFailed: 0
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

    if (settings.pendingConfirmationAlertTime && recoveryAllowed && clock.timeKey < settings.pendingConfirmationAlertTime) {
      const recoveryAlert = await runPendingConfirmationAlert({
        prismaClient,
        user,
        dateKey: recoveryScheduleDateKey,
        targetDateKey: recoveryTargetDateKey,
        axiosClient,
        sendAdminMessage,
        recoveryMode: true,
        now
      });
      if (recoveryAlert?.sent) {
        result.pendingAlertsSent += 1;
        result.recoveryPendingAlertsSent += 1;
      }
      if (recoveryAlert?.failed) {
        result.pendingAlertsFailed += 1;
        result.recoveryPendingAlertsFailed += 1;
      }
    }

    if (settings.pendingConfirmationAlertTime && clock.timeKey >= settings.pendingConfirmationAlertTime) {
      const alert = await runPendingConfirmationAlert({
        prismaClient,
        user,
        dateKey: clock.dateKey,
        targetDateKey,
        axiosClient,
        sendAdminMessage,
        now
      });
      if (alert?.sent) result.pendingAlertsSent += 1;
      if (alert?.failed) result.pendingAlertsFailed += 1;
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
    await markDispatchWhatsappNotification(prismaClient, claim, { sent: true });
    return { sent: true, userId: user.id, confirmedCount: assignments.length };
  } catch (error) {
    await markDispatchWhatsappNotification(prismaClient, claim, { sent: false, error }).catch(() => {});
    console.warn(`[dispatch-wa-cloud] Falló aviso de todos confirmados para ${user.username}: ${error?.message || error}`);
    return { sent: false, reason: 'provider_error', error: String(error?.message || error).slice(0, 300) };
  }
}

export async function runDispatchWhatsappWindowReminderDispatcher(prismaClient = prisma, { now = new Date(), axiosClient } = {}) {
  const nowMs = now.getTime();
  const openAfter = new Date(nowMs - DISPATCH_WHATSAPP_WINDOW_MS);
  const reminderDueBefore = new Date(nowMs - (DISPATCH_WHATSAPP_WINDOW_MS - DISPATCH_WINDOW_REMINDER_LEAD_MS));
  const [windows, users] = await Promise.all([
    prismaClient.dispatchWhatsappContactWindow.findMany({
      where: { scope: 'operational', lastInboundAt: { gt: openAfter, lte: reminderDueBefore } },
      orderBy: { lastInboundAt: 'asc' },
      take: 100
    }),
    prismaClient.appUser.findMany({
      where: { isActive: true, dispatchAlertPhone: { not: null } },
      select: { dispatchAlertPhone: true }
    })
  ]);
  const coordinatorPhones = new Set(users.map((user) => normalizeDispatchWhatsappPhone(user.dispatchAlertPhone)).filter(Boolean));
  let sent = 0;
  let failed = 0;
  for (const window of windows) {
    const phone = normalizeDispatchWhatsappPhone(window.phone);
    if (!phone || !coordinatorPhones.has(phone)) continue;
    const key = notificationKey(WINDOW_EXPIRY_NOTIFICATION, [window.scope, phone, new Date(window.lastInboundAt).toISOString()]);
    const claim = await claimDispatchWhatsappNotification(prismaClient, {
      notificationType: WINDOW_EXPIRY_NOTIFICATION,
      key,
      eventAt: window.lastInboundAt,
      now
    });
    if (!claim.claimed) continue;
    try {
      await sendDispatchWhatsappTextMessage({
        scope: 'operational',
        phone,
        text: buildDispatchWindowExpiryReminderText(),
        axiosClient
      });
      await markDispatchWhatsappNotification(prismaClient, claim, { sent: true });
      sent += 1;
    } catch (error) {
      await markDispatchWhatsappNotification(prismaClient, claim, { sent: false, error }).catch(() => {});
      failed += 1;
      console.warn(`[dispatch-wa-cloud] Falló recordatorio de ventana personal del coordinador: ${error?.message || error}`);
    }
  }
  await runDispatchUserAutomationScheduler(prismaClient, { now, axiosClient }).catch((error) =>
    console.warn('[DISPATCH_WHATSAPP_AUTOMATION_ERROR]', error?.message || error)
  );
  return { windowsChecked: windows.length, sent, failed };
}
