import { prisma } from '../lib/prisma.js';
import { dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import {
  closeDispatchWhatsappSession as closeRuntimeSession,
  getDispatchWhatsappStatus as getRuntimeStatus,
  getDispatchWhatsappStatusView as getRuntimeStatusView,
  initDispatchWhatsappClient,
  sendDispatchWhatsappMediaMessage,
  sendDispatchWhatsappMessage as sendRuntimeTextMessage
} from './dispatchWhatsappWebServiceV6.js';

const WATCHDOG_ENABLED = process.env.DISPATCH_WWEB_WATCHDOG_ENABLED !== 'false' && process.env.NODE_ENV !== 'test';
const WATCHDOG_INTERVAL_MS = Math.max(30000, Number(process.env.DISPATCH_WWEB_WATCHDOG_INTERVAL_MS || 60000));
const WATCHDOG_START_DELAY_MS = Math.max(0, Number(process.env.DISPATCH_WWEB_WATCHDOG_START_DELAY_MS || 5000));
const STALE_LINK_CLEANUP_LIMIT = Math.max(50, Number(process.env.DISPATCH_WA_STALE_LINK_CLEANUP_LIMIT || 1000));
const SENDABLE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING'];

let watchdogTimer = null;
let watchdogStartTimer = null;
let watchdogInFlight = false;

function buildOperationalError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function hourLabel(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return String(value || '');
  let hour = Number(match[1]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${match[2]} ${suffix}`;
}

function labelHours(value) {
  return String(value || '').replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:AM|PM|am|pm))/g, (_text, hour, minute) => hourLabel(`${hour}:${minute}`));
}

async function validateOutgoingAssignmentContext(context = {}) {
  const assignmentId = String(context?.assignmentId || '').trim();
  const serviceRequestId = String(context?.serviceRequestId || '').trim();
  if (!assignmentId && !serviceRequestId) return;
  if (!assignmentId || !serviceRequestId) {
    throw buildOperationalError('No se puede registrar la confirmación porque falta el contexto completo de la asignación.', 400);
  }

  const assignment = await prisma.dispatchAssignment.findFirst({
    where: {
      id: assignmentId,
      serviceRequestId,
      status: { in: SENDABLE_ASSIGNMENT_STATUSES }
    },
    select: {
      id: true,
      serviceRequest: { select: { serviceDate: true } }
    }
  });

  if (!assignment) {
    throw buildOperationalError('La asignación ya no está pendiente o no corresponde a la solicitud indicada.', 409);
  }

  const serviceDate = dispatchServiceDateKey(assignment.serviceRequest?.serviceDate);
  const today = todayIsoDateCO();
  if (!serviceDate || serviceDate < today) {
    throw buildOperationalError('No se puede solicitar confirmación para una asignación de una fecha anterior.', 409);
  }
}

async function expirePastConfirmationLinks(reason = 'watchdog') {
  const today = todayIsoDateCO();
  const links = await prisma.dispatchWhatsappConfirmation.findMany({
    where: { status: 'PENDING' },
    select: {
      id: true,
      assignment: {
        select: {
          serviceRequest: { select: { serviceDate: true } }
        }
      }
    },
    orderBy: { createdAt: 'asc' },
    take: STALE_LINK_CLEANUP_LIMIT
  });

  const staleIds = links
    .filter((link) => {
      const serviceDate = dispatchServiceDateKey(link.assignment?.serviceRequest?.serviceDate);
      return serviceDate && serviceDate < today;
    })
    .map((link) => link.id);

  if (!staleIds.length) return 0;
  const result = await prisma.dispatchWhatsappConfirmation.updateMany({
    where: { id: { in: staleIds }, status: 'PENDING' },
    data: { status: 'EXPIRED' }
  });
  console.log(`[dispatch-wa] Contextos antiguos de confirmación expirados=${result.count} reason=${reason} fechaCorte=${today}.`);
  return result.count;
}

async function runDispatchWhatsappWatchdog(reason = 'interval') {
  if (watchdogInFlight) return;
  watchdogInFlight = true;
  try {
    await expirePastConfirmationLinks(reason);
    const status = getRuntimeStatus();
    if (status.manualLogoutRequested) return;
    initDispatchWhatsappClient();
    await getRuntimeStatusView({ autoStart: true });
  } catch (error) {
    console.warn(`[dispatch-wa] Watchdog no pudo verificar la sesión. reason=${reason}`, error?.message || error);
  } finally {
    watchdogInFlight = false;
  }
}

export function startDispatchWhatsappWatchdog() {
  if (!WATCHDOG_ENABLED || watchdogTimer || watchdogStartTimer) return;
  expirePastConfirmationLinks('startup').catch((error) => {
    console.warn('[dispatch-wa] No fue posible expirar contextos antiguos al iniciar.', error?.message || error);
  });
  watchdogStartTimer = setTimeout(() => {
    watchdogStartTimer = null;
    runDispatchWhatsappWatchdog('startup').catch(() => {});
    watchdogTimer = setInterval(() => {
      runDispatchWhatsappWatchdog('interval').catch(() => {});
    }, WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref?.();
  }, WATCHDOG_START_DELAY_MS);
  watchdogStartTimer.unref?.();
}

export function stopDispatchWhatsappWatchdog() {
  if (watchdogStartTimer) clearTimeout(watchdogStartTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogStartTimer = null;
  watchdogTimer = null;
}

export function getDispatchWhatsappStatus() {
  return getRuntimeStatus();
}

export async function getDispatchWhatsappStatusView(options = {}) {
  return getRuntimeStatusView(options);
}

export async function closeDispatchWhatsappSession() {
  return closeRuntimeSession();
}

export async function sendDispatchWhatsappMessage(args = {}) {
  await validateOutgoingAssignmentContext(args.context);
  return sendRuntimeTextMessage({ ...args, message: labelHours(args.message) });
}

export { initDispatchWhatsappClient, sendDispatchWhatsappMediaMessage };

startDispatchWhatsappWatchdog();
