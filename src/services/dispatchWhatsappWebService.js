import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import {
  closeDispatchWhatsappSession as closeRuntimeSession,
  getDispatchWhatsappStatus as getRuntimeStatus,
  getDispatchWhatsappStatusView as getRuntimeStatusView,
  initDispatchWhatsappClient as initRuntimeClient,
  probeDispatchWhatsappClientHealth as probeRuntimeHealth,
  restartDispatchWhatsappClient as restartRuntimeClient,
  sendDispatchWhatsappMediaMessage,
  sendDispatchWhatsappMessage as sendRuntimeTextMessage
} from './dispatchWhatsappWebServiceV6.js';

const AUTO_START_ENABLED = process.env.DISPATCH_WWEB_AUTO_START !== 'false';
const WATCHDOG_ENABLED = AUTO_START_ENABLED
  && process.env.DISPATCH_WWEB_WATCHDOG_ENABLED !== 'false'
  && process.env.NODE_ENV !== 'test';
const WATCHDOG_INTERVAL_MS = Math.max(30000, Number(process.env.DISPATCH_WWEB_WATCHDOG_INTERVAL_MS || 60000));
const WATCHDOG_START_DELAY_MS = Math.max(0, Number(process.env.DISPATCH_WWEB_WATCHDOG_START_DELAY_MS || 5000));
const STALLED_INITIALIZATION_TIMEOUT_MS = Math.max(15000, Number(process.env.DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS || 60000));
const STALLED_INITIALIZATION_ERROR = 'La inicialización de WhatsApp de despacho superó el tiempo máximo. El sistema reinició la conexión automáticamente.';
const HEALTH_PROBE_TIMEOUT_MS = Math.max(3000, Number(process.env.DISPATCH_WWEB_HEALTH_TIMEOUT_MS || 10000));
const HEALTH_FAILURE_THRESHOLD = Math.max(1, Number(process.env.DISPATCH_WWEB_HEALTH_FAILURE_THRESHOLD || 2));
const STALE_LINK_CLEANUP_LIMIT = Math.max(50, Number(process.env.DISPATCH_WA_STALE_LINK_CLEANUP_LIMIT || 1000));
const SENDABLE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING'];
const EXPIRABLE_CONFIRMATION_LINK_STATUSES = ['PENDING', 'DELIVERY_UNKNOWN', 'CONFIRMED_REPLY_PENDING'];

let watchdogTimer = null;
let watchdogStartTimer = null;
let watchdogInFlight = false;
let initializingSeenAtMs = null;
let stalledInitializationError = null;
let runtimeEnvironmentPrepared = false;
let readyHealthFailures = 0;

function buildOperationalError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `57${digits}`;
  return digits;
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

function resolveAuthDataPath() {
  if (process.env.DISPATCH_WWEB_AUTH_PATH) return process.env.DISPATCH_WWEB_AUTH_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/dispatch-wweb-auth`;
  if (existsSync('/data')) return '/data/dispatch-wweb-auth';
  return './storage/dispatch-wweb-auth';
}

function killStaleChromiumProcesses(dataPath) {
  if (!dataPath || process.env.DISPATCH_WWEB_SKIP_STALE_PROCESS_CLEANUP === 'true') return;
  try {
    execFileSync('pkill', ['-f', dataPath], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch (error) {
    if (Number(error?.status) === 1 || error?.code === 'ENOENT') return;
    console.warn('[dispatch-wa] No fue posible limpiar procesos Chromium anteriores.', error?.message || error);
  }
}

function findNixChromiumExecutable() {
  const nixStorePath = '/nix/store';
  if (!existsSync(nixStorePath)) return undefined;
  try {
    const chromiumPackageDir = readdirSync(nixStorePath).find((entry) => entry.includes('chromium'));
    if (!chromiumPackageDir) return undefined;
    const chromiumPath = `${nixStorePath}/${chromiumPackageDir}/bin/chromium`;
    return existsSync(chromiumPath) ? chromiumPath : undefined;
  } catch (_error) {
    return undefined;
  }
}

function resolveChromeExecutablePath() {
  const candidates = [
    process.env.DISPATCH_BROWSER_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.GOOGLE_CHROME_BIN,
    process.env.CHROME_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    findNixChromiumExecutable()
  ].filter(Boolean);

  const configuredPath = candidates.find((candidate) => existsSync(candidate));
  if (configuredPath) return configuredPath;

  try {
    return execFileSync('sh', ['-c', "command -v chromium || command -v chromium-browser || command -v google-chrome-stable || command -v google-chrome || find /nix/store -path '*/bin/chromium' -type f 2>/dev/null | head -n 1"], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || undefined;
  } catch (_error) {
    return undefined;
  }
}

function prepareRuntimeEnvironment({ cleanupStaleProcesses = false } = {}) {
  const executablePath = resolveChromeExecutablePath();
  if (executablePath && !process.env.DISPATCH_BROWSER_EXECUTABLE_PATH) {
    process.env.DISPATCH_BROWSER_EXECUTABLE_PATH = executablePath;
  }
  if (cleanupStaleProcesses) killStaleChromiumProcesses(resolveAuthDataPath());
  runtimeEnvironmentPrepared = true;
}

async function validateOutgoingAssignmentContext(context = {}, phone = '') {
  const assignmentId = String(context?.assignmentId || '').trim();
  const serviceRequestId = String(context?.serviceRequestId || '').trim();
  const workerId = String(context?.workerId || '').trim();
  if (!assignmentId && !serviceRequestId && !workerId) return undefined;
  if (!assignmentId || !serviceRequestId || !workerId) {
    throw buildOperationalError('No se puede registrar la confirmación porque falta el contexto completo de la asignación.', 400);
  }

  const assignment = await prisma.dispatchAssignment.findFirst({
    where: {
      id: assignmentId,
      serviceRequestId,
      workerId,
      status: { in: SENDABLE_ASSIGNMENT_STATUSES }
    },
    select: {
      id: true,
      workerId: true,
      worker: { select: { phone: true } },
      serviceRequest: { select: { serviceDate: true } }
    }
  });

  if (!assignment) {
    throw buildOperationalError('La asignación ya no está pendiente o no corresponde a la solicitud y auxiliar indicados.', 409);
  }

  const recipientPhone = normalizePhone(phone);
  const assignmentPhone = normalizePhone(assignment.worker?.phone);
  if (!recipientPhone || !assignmentPhone || recipientPhone !== assignmentPhone) {
    throw buildOperationalError('El número indicado no corresponde al auxiliar de esta asignación.', 409);
  }

  const serviceDate = dispatchServiceDateKey(assignment.serviceRequest?.serviceDate);
  const today = todayIsoDateCO();
  if (!serviceDate || serviceDate < today) {
    throw buildOperationalError('No se puede solicitar confirmación para una asignación de una fecha anterior.', 409);
  }

  return { ...context, assignmentId, serviceRequestId, workerId };
}

async function expirePastConfirmationLinks(reason = 'watchdog') {
  const today = todayIsoDateCO();
  const links = await prisma.dispatchWhatsappConfirmation.findMany({
    where: { status: { in: EXPIRABLE_CONFIRMATION_LINK_STATUSES } },
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
    where: { id: { in: staleIds }, status: { in: EXPIRABLE_CONFIRMATION_LINK_STATUSES } },
    data: { status: 'EXPIRED' }
  });
  console.log(`[dispatch-wa] Contextos antiguos de confirmación expirados=${result.count} reason=${reason} fechaCorte=${today}.`);
  return result.count;
}

function hasInitializationProgress(status = {}) {
  return Boolean(status.ready || status.lastQr || status.lastError || status.manualLogoutRequested);
}

async function recoverStalledInitialization(status = getRuntimeStatus(), reason = 'status') {
  if (!status.initializing || hasInitializationProgress(status)) {
    initializingSeenAtMs = null;
    if (status.ready || status.lastQr) stalledInitializationError = null;
    return false;
  }

  const now = Date.now();
  if (!initializingSeenAtMs) {
    initializingSeenAtMs = now;
    return false;
  }
  if (now - initializingSeenAtMs < STALLED_INITIALIZATION_TIMEOUT_MS) return false;

  initializingSeenAtMs = null;
  stalledInitializationError = STALLED_INITIALIZATION_ERROR;
  console.warn(`[dispatch-wa] ${STALLED_INITIALIZATION_ERROR} reason=${reason}`);
  await restartDispatchWhatsappClient(`stalled:${reason}`);
  return true;
}

async function runDispatchWhatsappWatchdog(reason = 'interval') {
  if (watchdogInFlight) return;
  watchdogInFlight = true;
  try {
    await expirePastConfirmationLinks(reason);
    const status = getRuntimeStatus();
    if (status.manualLogoutRequested) {
      initializingSeenAtMs = null;
      readyHealthFailures = 0;
      return;
    }

    if (status.ready) {
      const health = await probeRuntimeHealth({ timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
      if (health.healthy) {
        readyHealthFailures = 0;
        return;
      }
      readyHealthFailures += 1;
      console.warn(`[dispatch-wa] Comprobación de salud fallida. state=${health.state || 'unknown'} failures=${readyHealthFailures}/${HEALTH_FAILURE_THRESHOLD}.`);
      if (readyHealthFailures >= HEALTH_FAILURE_THRESHOLD) {
        readyHealthFailures = 0;
        initializingSeenAtMs = null;
        await restartDispatchWhatsappClient(`health:${health.state || reason}`);
      }
      return;
    }

    readyHealthFailures = 0;
    if (await recoverStalledInitialization(status, `watchdog:${reason}`)) return;

    initDispatchWhatsappClient();
  } catch (error) {
    console.warn(`[dispatch-wa] Watchdog no pudo verificar la sesión. reason=${reason}`, error?.message || error);
  } finally {
    watchdogInFlight = false;
  }
}

export function startDispatchWhatsappWatchdog() {
  if (!WATCHDOG_ENABLED || watchdogTimer || watchdogStartTimer) return;
  if (!runtimeEnvironmentPrepared) prepareRuntimeEnvironment({ cleanupStaleProcesses: true });
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
  initializingSeenAtMs = null;
}

export function initDispatchWhatsappClient() {
  if (!runtimeEnvironmentPrepared) prepareRuntimeEnvironment({ cleanupStaleProcesses: true });
  const status = getRuntimeStatus();
  if (!status.ready && !status.initializing && !status.lastQr && !status.lastError) {
    initializingSeenAtMs = Date.now();
  }
  return initRuntimeClient();
}

export function getDispatchWhatsappStatus() {
  const status = getRuntimeStatus();
  if (status.ready || status.lastQr) stalledInitializationError = null;
  return { ...status, lastError: status.lastError || stalledInitializationError };
}

export async function getDispatchWhatsappStatusView(options = {}) {
  let status = await getRuntimeStatusView(options);
  if (await recoverStalledInitialization(status, 'status-view')) {
    status = await getRuntimeStatusView({ autoStart: false });
  }
  if (status.ready || status.lastQr) stalledInitializationError = null;
  return { ...status, lastError: status.lastError || stalledInitializationError };
}

export async function restartDispatchWhatsappClient(reason = 'recuperación automática') {
  if (!runtimeEnvironmentPrepared) prepareRuntimeEnvironment({ cleanupStaleProcesses: true });
  const status = getRuntimeStatus();
  killStaleChromiumProcesses(status.authDataPath || resolveAuthDataPath());
  const restarted = await restartRuntimeClient(reason);
  initializingSeenAtMs = Date.now();
  return restarted;
}

export async function closeDispatchWhatsappSession() {
  stopDispatchWhatsappWatchdog();
  runtimeEnvironmentPrepared = false;
  readyHealthFailures = 0;
  initializingSeenAtMs = null;
  stalledInitializationError = null;
  return closeRuntimeSession();
}

export async function sendDispatchWhatsappMessage(args = {}) {
  const context = await validateOutgoingAssignmentContext(args.context, args.phone);
  return sendRuntimeTextMessage({ ...args, context, message: labelHours(args.message) });
}

export { sendDispatchWhatsappMediaMessage };

startDispatchWhatsappWatchdog();