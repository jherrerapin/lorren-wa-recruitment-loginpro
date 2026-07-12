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

let watchdogTimer = null;
let watchdogStartTimer = null;
let watchdogInFlight = false;

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

async function runDispatchWhatsappWatchdog(reason = 'interval') {
  if (watchdogInFlight) return;
  watchdogInFlight = true;
  try {
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
  return sendRuntimeTextMessage({ ...args, message: labelHours(args.message) });
}

export { initDispatchWhatsappClient, sendDispatchWhatsappMediaMessage };

startDispatchWhatsappWatchdog();
