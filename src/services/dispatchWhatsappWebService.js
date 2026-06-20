import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';

const { Client, LocalAuth, MessageMedia } = whatsappWeb;
const MAX_MESSAGE_LENGTH = 3500;
const NOT_CONNECTED_MESSAGE = 'WhatsApp de despacho no está conectado. Escanea el QR e intenta nuevamente.';
const DUPLICATE_SEND_WINDOW_MS = Number(process.env.DISPATCH_DUPLICATE_SEND_WINDOW_MS || 120000);
const RECONNECT_DELAY_MS = Number(process.env.DISPATCH_WWEB_RECONNECT_DELAY_MS || 5000);
const STALE_CONNECTING_WINDOW_MS = Number(process.env.DISPATCH_WWEB_STALE_CONNECTING_MS || 45000);
const CHROME_LOCK_FILENAMES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']);

let client = null;
let initializing = false;
let ready = false;
let lastQr = null;
let lastError = null;
let lastReadyAt = null;
let lastAuthenticatedAt = null;
let lastInitializationAt = null;
let reconnectTimer = null;
const recentSendLocks = new Map();

function buildError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `57${digits}`;
  if (digits.startsWith('57')) return digits;
  return digits;
}

function normalizeMessage(message) {
  return String(message || '').trim().slice(0, MAX_MESSAGE_LENGTH);
}

function buildSendLockKey({ channelType, phone, payload }) {
  return [channelType, phone, payload].join('|');
}

function cleanupExpiredSendLocks(now = Date.now()) {
  for (const [key, value] of recentSendLocks.entries()) {
    if (value.expiresAt <= now) recentSendLocks.delete(key);
  }
}

function reserveSendLock({ channelType, phone, payload }) {
  if (!DUPLICATE_SEND_WINDOW_MS || DUPLICATE_SEND_WINDOW_MS < 1) return null;
  const now = Date.now();
  cleanupExpiredSendLocks(now);
  const key = buildSendLockKey({ channelType, phone, payload });
  const existing = recentSendLocks.get(key);
  if (existing?.expiresAt > now) {
    const remainingSeconds = Math.ceil((existing.expiresAt - now) / 1000);
    throw buildError(`Este mismo mensaje ya fue enviado o está en proceso para este número. Espera ${remainingSeconds} segundos antes de repetirlo.`, 429);
  }
  recentSendLocks.set(key, { expiresAt: now + DUPLICATE_SEND_WINDOW_MS });
  return key;
}

function releaseSendLock(key) {
  if (key) recentSendLocks.delete(key);
}

function resolveAuthDataPath() {
  if (process.env.DISPATCH_WWEB_AUTH_PATH) return process.env.DISPATCH_WWEB_AUTH_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/dispatch-wweb-auth`;
  return './storage/dispatch-wweb-auth';
}

function ensureAuthDataPath() {
  const dataPath = resolveAuthDataPath();
  try {
    mkdirSync(dataPath, { recursive: true });
  } catch (error) {
    console.warn('No fue posible crear/verificar carpeta de sesión de WhatsApp despacho.', error);
  }
  return dataPath;
}

function removeChromeProfileLocks(rootPath) {
  if (!rootPath || !existsSync(rootPath)) return;
  const pending = [rootPath];
  while (pending.length) {
    const currentPath = pending.pop();
    let entries = [];
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      if (CHROME_LOCK_FILENAMES.has(entry.name)) {
        try {
          rmSync(entryPath, { force: true, recursive: true });
          console.warn(`Archivo de bloqueo de Chrome eliminado para WhatsApp despacho: ${entryPath}`);
        } catch (error) {
          console.warn(`No fue posible eliminar bloqueo de Chrome ${entryPath}.`, error);
        }
        continue;
      }
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
}

function killChromeProcessesForProfile(rootPath) {
  if (!rootPath || !existsSync(rootPath)) return;
  const escapedPath = rootPath.replace(/'/g, `'\\''`);
  try {
    execFileSync('sh', ['-c', `pkill -f '${escapedPath}' || true`], { stdio: 'ignore' });
  } catch (_error) {
    // pkill returns non-zero when there is no matching process. That is acceptable.
  }
}

function cleanupStaleChromeState(dataPath, reason = 'inicio') {
  if (process.env.DISPATCH_WWEB_CLEAN_PROFILE_LOCKS === 'false') return;
  killChromeProcessesForProfile(dataPath);
  removeChromeProfileLocks(dataPath);
  if (reason) console.warn(`Limpieza de bloqueos de Chrome para WhatsApp despacho ejecutada: ${reason}.`);
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
    '/usr/bin/google-chrome'
  ].filter(Boolean);

  const configuredPath = candidates.find((candidate) => existsSync(candidate));
  if (configuredPath) return configuredPath;

  try {
    return execFileSync('sh', ['-c', 'command -v chromium || command -v chromium-browser || command -v google-chrome-stable || command -v google-chrome'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || undefined;
  } catch (_error) {
    return undefined;
  }
}

function buildPuppeteerOptions() {
  const executablePath = resolveChromeExecutablePath();
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions'
    ]
  };
}

function isChromeProfileLockedError(error) {
  const rawMessage = error?.message || '';
  return /profile appears to be in use|ProcessSingleton|SingletonLock|Code:\s*21/i.test(rawMessage);
}

function formatBrowserLaunchError(error) {
  const rawMessage = error?.message || 'No fue posible inicializar WhatsApp de despacho.';
  if (isChromeProfileLockedError(error)) {
    return 'El perfil de Chrome de WhatsApp despacho quedó bloqueado por un proceso anterior. El sistema limpió el bloqueo y reintentará la conexión.';
  }
  if (rawMessage.includes('ENOENT') || rawMessage.includes('Could not find Chrome') || rawMessage.includes('Failed to launch the browser process')) {
    return 'No se encontró Chrome/Chromium en el servidor para iniciar la sesión de WhatsApp despacho.';
  }
  return rawMessage;
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(reason) {
  if (reconnectTimer || initializing) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log(`Reintentando conexión de WhatsApp despacho${reason ? ` (${reason})` : ''}.`);
    initDispatchWhatsappClient();
  }, RECONNECT_DELAY_MS);
}

function resetClientReference() {
  const oldClient = client;
  client = null;
  initializing = false;
  ready = false;
  if (oldClient) {
    oldClient.destroy().catch((error) => {
      console.warn('No fue posible cerrar completamente el cliente anterior de WhatsApp despacho.', error);
    });
  }
}

function hasStaleClientWithoutQr(now = Date.now()) {
  if (!client || ready || lastQr || initializing) return false;
  if (lastError) return true;
  if (!lastInitializationAt) return true;
  return now - new Date(lastInitializationAt).getTime() > STALE_CONNECTING_WINDOW_MS;
}

async function getReadyClient() {
  ensureDispatchWhatsappClientRunning();
  if (!ready) throw buildError(NOT_CONNECTED_MESSAGE, 503);
  return client;
}

async function getRecipientId(activeClient, phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw buildError('Debes indicar un número válido para enviar WhatsApp.', 400);
  if (normalizedPhone.length < 11 || normalizedPhone.length > 15) throw buildError('El número de WhatsApp no es válido.', 400);
  const numberId = await activeClient.getNumberId(normalizedPhone);
  if (!numberId?._serialized) throw buildError('El número no está disponible en WhatsApp.', 400);
  return { normalizedPhone, serializedId: numberId._serialized };
}

export function initDispatchWhatsappClient() {
  if (client || initializing) return client;

  const dataPath = ensureAuthDataPath();
  cleanupStaleChromeState(dataPath, 'antes de iniciar cliente');
  clearReconnectTimer();
  initializing = true;
  lastInitializationAt = new Date().toISOString();
  client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'dispatch',
      dataPath
    }),
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    puppeteer: buildPuppeteerOptions()
  });

  client.on('qr', (qr) => {
    lastQr = qr;
    ready = false;
    lastError = null;
    console.log('QR de WhatsApp despacho pendiente. Escanéalo para vincular la sesión:');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    lastAuthenticatedAt = new Date().toISOString();
    lastError = null;
    console.log('WhatsApp de despacho autenticado.');
  });

  client.on('ready', () => {
    ready = true;
    lastQr = null;
    lastError = null;
    lastReadyAt = new Date().toISOString();
    console.log('WhatsApp de despacho conectado.');
  });

  client.on('disconnected', (reason) => {
    ready = false;
    lastQr = null;
    lastReadyAt = null;
    lastAuthenticatedAt = null;
    lastError = reason ? `WhatsApp de despacho desconectado: ${reason}` : 'WhatsApp de despacho desconectado.';
    console.warn(lastError);
    resetClientReference();
    scheduleReconnect(reason || 'desconectado');
  });

  client.on('auth_failure', (message) => {
    ready = false;
    lastQr = null;
    lastReadyAt = null;
    lastAuthenticatedAt = null;
    lastError = message ? `Fallo de autenticación de WhatsApp despacho: ${message}` : 'Fallo de autenticación de WhatsApp despacho.';
    console.warn(lastError);
    resetClientReference();
    scheduleReconnect('fallo de autenticación');
  });

  client.initialize().catch((error) => {
    ready = false;
    lastQr = null;
    lastReadyAt = null;
    lastAuthenticatedAt = null;
    lastError = formatBrowserLaunchError(error);
    if (isChromeProfileLockedError(error)) cleanupStaleChromeState(dataPath, 'perfil bloqueado tras fallo de inicio');
    resetClientReference();
    console.error('Error inicializando WhatsApp de despacho.', error);
    scheduleReconnect(isChromeProfileLockedError(error) ? 'perfil de Chrome bloqueado' : 'error de inicio');
  }).finally(() => {
    initializing = false;
  });

  return client;
}

export function ensureDispatchWhatsappClientRunning() {
  if (!client && !initializing) {
    initDispatchWhatsappClient();
    return;
  }
  if (hasStaleClientWithoutQr()) {
    restartDispatchWhatsappClient('cliente sin QR ni estado listo');
  }
}

export function restartDispatchWhatsappClient(reason = 'reinicio manual') {
  console.warn(`Reiniciando WhatsApp de despacho: ${reason}.`);
  clearReconnectTimer();
  resetClientReference();
  lastQr = null;
  lastError = null;
  cleanupStaleChromeState(resolveAuthDataPath(), reason);
  initDispatchWhatsappClient();
}

export function getDispatchWhatsappStatus() {
  ensureDispatchWhatsappClientRunning();
  return { ready, initializing, lastQr, lastError, lastReadyAt, lastAuthenticatedAt, lastInitializationAt, authDataPath: resolveAuthDataPath() };
}

export async function getDispatchWhatsappStatusView() {
  ensureDispatchWhatsappClientRunning();
  let qrImage = null;
  if (lastQr) {
    try {
      qrImage = await QRCode.toDataURL(lastQr);
    } catch (error) {
      console.error('No fue posible generar imagen QR de WhatsApp despacho.', error);
    }
  }
  return { ready, initializing, lastQr, qrImage, lastError, lastReadyAt, lastAuthenticatedAt, lastInitializationAt, authDataPath: resolveAuthDataPath() };
}

export async function sendDispatchWhatsappMessage({ phone, message }) {
  const normalizedMessage = normalizeMessage(message);
  if (!normalizedMessage) throw buildError('El mensaje de WhatsApp no puede estar vacío.', 400);
  if (/<[^>]+>/.test(normalizedMessage)) throw buildError('El mensaje de WhatsApp no puede contener HTML.', 400);

  const activeClient = await getReadyClient();
  const recipient = await getRecipientId(activeClient, phone);
  const lockKey = reserveSendLock({ channelType: 'text', phone: recipient.normalizedPhone, payload: normalizedMessage });
  try {
    const sent = await activeClient.sendMessage(recipient.serializedId, normalizedMessage);
    return {
      phone: recipient.normalizedPhone,
      providerMessageId: sent?.id?._serialized || sent?.id?.id || null
    };
  } catch (error) {
    releaseSendLock(lockKey);
    throw error;
  }
}

export async function sendDispatchWhatsappMediaMessage({ phone, caption, buffer, filename, mimeType = 'application/pdf' }) {
  const normalizedCaption = normalizeMessage(caption);
  if (!Buffer.isBuffer(buffer)) throw buildError('El archivo de WhatsApp no es válido.', 400);
  if (!buffer.length) throw buildError('El archivo de WhatsApp está vacío.', 400);
  if (normalizedCaption && /<[^>]+>/.test(normalizedCaption)) throw buildError('El mensaje de WhatsApp no puede contener HTML.', 400);

  const activeClient = await getReadyClient();
  const recipient = await getRecipientId(activeClient, phone);
  const lockKey = reserveSendLock({ channelType: 'media', phone: recipient.normalizedPhone, payload: `${filename || 'programacion.pdf'}:${normalizedCaption}` });
  try {
    const media = new MessageMedia(mimeType, buffer.toString('base64'), filename || 'programacion.pdf');
    const sent = await activeClient.sendMessage(recipient.serializedId, media, { caption: normalizedCaption });
    return {
      phone: recipient.normalizedPhone,
      providerMessageId: sent?.id?._serialized || sent?.id?.id || null
    };
  } catch (error) {
    releaseSendLock(lockKey);
    throw error;
  }
}
