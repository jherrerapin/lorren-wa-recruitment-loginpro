import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';

const { Client, LocalAuth, MessageMedia } = whatsappWeb;
const MAX_MESSAGE_LENGTH = 3500;
const NOT_CONNECTED_MESSAGE = 'WhatsApp de despacho no está conectado. Escanea el QR e intenta nuevamente.';
const DUPLICATE_SEND_WINDOW_MS = Number(process.env.DISPATCH_DUPLICATE_SEND_WINDOW_MS || 120000);
const RECONNECT_DELAY_MS = Number(process.env.DISPATCH_WHATSAPP_RECONNECT_DELAY_MS || 5000);
const AUTH_DATA_PATH = resolveAuthDataPath();

let client = null;
let initializing = false;
let ready = false;
let lastQr = null;
let lastError = null;
let lastReadyAt = null;
let lastAuthenticatedAt = null;
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

function ensureDirectory(path) {
  try {
    mkdirSync(path, { recursive: true });
    return path;
  } catch (error) {
    console.warn(`No fue posible preparar el directorio de sesión WhatsApp (${path}).`, error?.message || error);
    return null;
  }
}

function resolveAuthDataPath() {
  const configured = process.env.DISPATCH_WWEB_AUTH_PATH || process.env.DISPATCH_WHATSAPP_AUTH_PATH;
  if (configured) return ensureDirectory(configured) || configured;

  const volumeBase = process.env.RAILWAY_VOLUME_MOUNT_PATH || (existsSync('/data') ? '/data' : null);
  if (volumeBase) {
    const volumePath = `${volumeBase.replace(/\/$/, '')}/dispatch-wweb-auth`;
    const prepared = ensureDirectory(volumePath);
    if (prepared) return prepared;
  }

  return ensureDirectory('./storage/dispatch-wweb-auth') || './storage/dispatch-wweb-auth';
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
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  };
}

function formatBrowserLaunchError(error) {
  const rawMessage = error?.message || 'No fue posible inicializar WhatsApp de despacho.';
  if (rawMessage.includes('ENOENT') || rawMessage.includes('Could not find Chrome') || rawMessage.includes('Failed to launch the browser process')) {
    return 'No se encontró Chrome/Chromium en el servidor para iniciar la sesión de WhatsApp despacho.';
  }
  return rawMessage;
}

async function destroyCurrentClient() {
  const current = client;
  client = null;
  ready = false;
  if (!current) return;
  try {
    await current.destroy();
  } catch (error) {
    console.warn('No fue posible cerrar limpiamente la sesión interna de WhatsApp despacho.', error?.message || error);
  }
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await destroyCurrentClient();
    lastError = reason ? `Reintentando conexión de WhatsApp despacho: ${reason}` : 'Reintentando conexión de WhatsApp despacho.';
    initDispatchWhatsappClient();
  }, Number.isFinite(RECONNECT_DELAY_MS) && RECONNECT_DELAY_MS >= 1000 ? RECONNECT_DELAY_MS : 5000);
}

async function getReadyClient() {
  if (!client) initDispatchWhatsappClient();
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

  initializing = true;
  client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'dispatch',
      dataPath: AUTH_DATA_PATH
    }),
    takeoverOnConflict: true,
    takeoverTimeoutMs: 15000,
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
    console.log('WhatsApp de despacho conectado. Sesión persistente en:', AUTH_DATA_PATH);
  });

  client.on('disconnected', (reason) => {
    ready = false;
    lastQr = null;
    lastError = reason ? `WhatsApp de despacho desconectado: ${reason}` : 'WhatsApp de despacho desconectado.';
    console.warn(lastError);
    scheduleReconnect(reason || 'desconexión inesperada');
  });

  client.on('auth_failure', (message) => {
    ready = false;
    lastQr = null;
    lastError = message ? `Fallo de autenticación de WhatsApp despacho: ${message}` : 'Fallo de autenticación de WhatsApp despacho.';
    console.warn(lastError);
    scheduleReconnect(message || 'fallo de autenticación');
  });

  client.initialize().catch((error) => {
    ready = false;
    lastQr = null;
    lastError = formatBrowserLaunchError(error);
    console.error('Error inicializando WhatsApp de despacho.', error);
    scheduleReconnect(lastError);
  }).finally(() => {
    initializing = false;
  });

  return client;
}

export function getDispatchWhatsappStatus() {
  return { ready, lastQr, lastError, lastReadyAt, lastAuthenticatedAt, authDataPath: AUTH_DATA_PATH };
}

export async function getDispatchWhatsappStatusView() {
  let qrImage = null;
  if (lastQr) {
    try {
      qrImage = await QRCode.toDataURL(lastQr);
    } catch (error) {
      console.error('No fue posible generar imagen QR de WhatsApp despacho.', error);
    }
  }
  return { ready, lastQr, qrImage, lastError, lastReadyAt, lastAuthenticatedAt, authDataPath: AUTH_DATA_PATH };
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
