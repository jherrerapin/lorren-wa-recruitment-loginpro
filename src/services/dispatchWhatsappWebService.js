import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma.js';

const MAX_MESSAGE_LENGTH = 3500;
const NOT_CONNECTED_MESSAGE = 'WhatsApp de despacho no está conectado. Escanea el QR e intenta nuevamente.';
const DUPLICATE_SEND_WINDOW_MS = Number(process.env.DISPATCH_DUPLICATE_SEND_WINDOW_MS || 120000);
const RECONNECT_DELAY_MS = Number(process.env.DISPATCH_WWEB_RECONNECT_DELAY_MS || 5000);
const CONFIRMATION_MEMORY_TTL_MS = Number(process.env.DISPATCH_WA_CONFIRMATION_MEMORY_TTL_MS || 36 * 60 * 60 * 1000);
const CHROMIUM_LOCK_FILES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
const PENDING_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING'];
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const AUTOMATIC_CONFIRMATION_REPLY = 'Gracias.';

let Client = null;
let LocalAuth = null;
let MessageMedia = null;
let whatsappModuleLoadPromise = null;
let client = null;
let initializing = false;
let ready = false;
let lastQr = null;
let lastError = null;
let lastReadyAt = null;
let lastAuthenticatedAt = null;
let reconnectTimer = null;
const recentSendLocks = new Map();
const pendingConfirmationByPhone = new Map();

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

function normalizeConfirmationText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isAutomaticConfirmationReply(value) {
  return normalizeConfirmationText(value) === 'confirmado';
}

function normalizeWhatsappSenderId(senderId) {
  const raw = String(senderId || '').split('@')[0];
  return normalizePhone(raw);
}

function buildSendLockKey({ channelType, phone, payload }) {
  return [channelType, phone, payload].join('|');
}

function cleanupExpiredSendLocks(now = Date.now()) {
  for (const [key, value] of recentSendLocks.entries()) {
    if (value.expiresAt <= now) recentSendLocks.delete(key);
  }
}

function cleanupExpiredPendingConfirmations(now = Date.now()) {
  for (const [phone, value] of pendingConfirmationByPhone.entries()) {
    if (value.expiresAt <= now) pendingConfirmationByPhone.delete(phone);
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

function rememberPendingConfirmation(phone, context = {}) {
  const normalizedPhone = normalizePhone(phone);
  const assignmentId = String(context?.assignmentId || '').trim();
  if (!normalizedPhone || !assignmentId) return;
  pendingConfirmationByPhone.set(normalizedPhone, {
    assignmentId,
    serviceRequestId: String(context?.serviceRequestId || '').trim() || null,
    expiresAt: Date.now() + CONFIRMATION_MEMORY_TTL_MS
  });
}

async function loadWhatsappWebModule() {
  if (Client && LocalAuth && MessageMedia) return { Client, LocalAuth, MessageMedia };
  if (!whatsappModuleLoadPromise) {
    whatsappModuleLoadPromise = import('whatsapp-web.js')
      .then((module) => {
        const whatsappWeb = module.default || module;
        Client = whatsappWeb.Client;
        LocalAuth = whatsappWeb.LocalAuth;
        MessageMedia = whatsappWeb.MessageMedia;
        if (!Client || !LocalAuth || !MessageMedia) {
          throw new Error('El módulo whatsapp-web.js no expuso Client, LocalAuth o MessageMedia.');
        }
        return { Client, LocalAuth, MessageMedia };
      })
      .catch((error) => {
        whatsappModuleLoadPromise = null;
        lastError = `No fue posible cargar whatsapp-web.js: ${error?.message || 'error desconocido'}`;
        console.error(lastError, error);
        throw error;
      });
  }
  return whatsappModuleLoadPromise;
}

async function printTerminalQr(qr) {
  try {
    const module = await import('qrcode-terminal');
    const terminalQr = module.default || module;
    terminalQr.generate(qr, { small: true });
  } catch (error) {
    console.warn('No fue posible imprimir el QR de WhatsApp despacho en consola.', error);
  }
}

function resolveAuthDataPath() {
  if (process.env.DISPATCH_WWEB_AUTH_PATH) return process.env.DISPATCH_WWEB_AUTH_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/dispatch-wweb-auth`;
  if (existsSync('/data')) return '/data/dispatch-wweb-auth';
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

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\''`)}'`;
}

function killStaleChromiumProcesses(dataPath) {
  if (!dataPath || process.env.DISPATCH_WWEB_SKIP_STALE_PROCESS_CLEANUP === 'true') return;
  try {
    execFileSync('sh', ['-c', `pkill -f ${shellQuote(dataPath)} || true`], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch (error) {
    console.warn('No fue posible limpiar procesos Chromium anteriores de WhatsApp despacho.', error);
  }
}

function cleanupChromiumProfileLocks(rootPath, depth = 0) {
  if (!rootPath || depth > 5 || !existsSync(rootPath)) return;
  let entries = [];
  try {
    entries = readdirSync(rootPath, { withFileTypes: true });
  } catch (error) {
    console.warn(`No fue posible leer carpeta de sesión WhatsApp despacho: ${rootPath}`, error);
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      cleanupChromiumProfileLocks(entryPath, depth + 1);
      continue;
    }
    if (!CHROMIUM_LOCK_FILES.has(entry.name)) continue;
    try {
      rmSync(entryPath, { force: true, recursive: true });
      console.log(`Lock stale de Chromium eliminado: ${entryPath}`);
    } catch (error) {
      console.warn(`No fue posible eliminar lock stale de Chromium: ${entryPath}`, error);
    }
  }
}

function prepareChromiumProfile(dataPath) {
  killStaleChromiumProcesses(dataPath);
  cleanupChromiumProfileLocks(dataPath);
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
    return execFileSync('sh', ['-c', 'command -v chromium || command -v chromium-browser || command -v google-chrome-stable || command -v google-chrome || find /nix/store -path \'*/bin/chromium\' -type f 2>/dev/null | head -n 1'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || undefined;
  } catch (_error) {
    return undefined;
  }
}

function buildPuppeteerOptions() {
  const executablePath = resolveChromeExecutablePath();
  if (!executablePath) {
    lastError = 'No se encontró Chrome/Chromium en el servidor para iniciar la sesión de WhatsApp despacho. Verifica que el despliegue instale Chromium y exponga DISPATCH_BROWSER_EXECUTABLE_PATH, PUPPETEER_EXECUTABLE_PATH, GOOGLE_CHROME_BIN o CHROME_BIN.';
    console.warn(lastError);
  }
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
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=site-per-process',
      '--disable-software-rasterizer'
    ]
  };
}

function formatBrowserLaunchError(error) {
  const rawMessage = error?.message || 'No fue posible inicializar WhatsApp de despacho.';
  if (rawMessage.includes('The profile appears to be in use') || rawMessage.includes('process_singleton_posix')) {
    return 'El perfil de WhatsApp despacho estaba bloqueado por Chromium. El sistema limpió el lock y reintentará la conexión.';
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

async function recalculateServiceRequestStatus(serviceRequestId) {
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { id: true, requiredWorkers: true }
  });
  if (!serviceRequest) return null;

  const [activeCount, confirmedCount] = await Promise.all([
    prisma.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }),
    prisma.dispatchAssignment.count({ where: { serviceRequestId, status: CONFIRMED_ASSIGNMENT_STATUS } })
  ]);

  let status = 'PENDING_ASSIGNMENT';
  if (confirmedCount >= serviceRequest.requiredWorkers) status = 'ASSIGNMENT_COMPLETE';
  else if (activeCount >= serviceRequest.requiredWorkers) status = 'PENDING_CONFIRMATION';
  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';

  await prisma.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
  return { status, activeCount, confirmedCount, requiredWorkers: serviceRequest.requiredWorkers };
}

async function findPendingAssignmentFromMemory(phone) {
  cleanupExpiredPendingConfirmations();
  const remembered = pendingConfirmationByPhone.get(phone);
  if (!remembered?.assignmentId) return null;
  const assignment = await prisma.dispatchAssignment.findFirst({
    where: {
      id: remembered.assignmentId,
      status: { in: PENDING_ASSIGNMENT_STATUSES }
    },
    include: { worker: true }
  });
  if (!assignment) return null;
  if (normalizePhone(assignment.worker?.phone) !== phone) return null;
  return assignment;
}

async function findLatestPendingAssignmentByPhone(phone) {
  const lastTen = phone.slice(-10);
  if (!lastTen) return null;
  const candidates = await prisma.dispatchAssignment.findMany({
    where: {
      status: { in: PENDING_ASSIGNMENT_STATUSES },
      worker: { phone: { contains: lastTen } }
    },
    include: { worker: true },
    orderBy: { updatedAt: 'desc' },
    take: 10
  });
  return candidates.find((assignment) => normalizePhone(assignment.worker?.phone) === phone) || null;
}

async function confirmAssignmentFromInboundMessage(activeClient, message) {
  if (message?.fromMe) return false;
  const sender = String(message?.from || '');
  if (!sender.endsWith('@c.us')) return false;
  if (!isAutomaticConfirmationReply(message?.body)) return false;

  const phone = normalizeWhatsappSenderId(sender);
  if (!phone) return false;

  const assignment = await findPendingAssignmentFromMemory(phone) || await findLatestPendingAssignmentByPhone(phone);
  if (!assignment) return false;

  await prisma.dispatchAssignment.update({
    where: { id: assignment.id },
    data: { status: CONFIRMED_ASSIGNMENT_STATUS }
  });
  await recalculateServiceRequestStatus(assignment.serviceRequestId);
  pendingConfirmationByPhone.delete(phone);
  await activeClient.sendMessage(sender, AUTOMATIC_CONFIRMATION_REPLY);
  console.log(`[dispatch-wa] Confirmación automática registrada para assignment=${assignment.id} phone=${phone}.`);
  return true;
}

export function initDispatchWhatsappClient() {
  if (client || initializing) return client;

  const dataPath = ensureAuthDataPath();
  prepareChromiumProfile(dataPath);
  clearReconnectTimer();
  initializing = true;

  loadWhatsappWebModule()
    .then(({ Client: WhatsappClient, LocalAuth: WhatsappLocalAuth }) => {
      if (client) return client;
      client = new WhatsappClient({
        authStrategy: new WhatsappLocalAuth({
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
        printTerminalQr(qr);
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

      client.on('message', (message) => {
        confirmAssignmentFromInboundMessage(client, message).catch((error) => {
          console.error('[dispatch-wa] Error procesando respuesta entrante.', error);
        });
      });

      client.on('disconnected', (reason) => {
        ready = false;
        lastQr = null;
        lastError = reason ? `WhatsApp de despacho desconectado: ${reason}` : 'WhatsApp de despacho desconectado.';
        console.warn(lastError);
        resetClientReference();
        scheduleReconnect(reason || 'desconectado');
      });

      client.on('auth_failure', (message) => {
        ready = false;
        lastQr = null;
        lastError = message ? `Fallo de autenticación de WhatsApp despacho: ${message}` : 'Fallo de autenticación de WhatsApp despacho.';
        console.warn(lastError);
        resetClientReference();
        scheduleReconnect('fallo de autenticación');
      });

      client.initialize().catch((error) => {
        ready = false;
        lastQr = null;
        lastError = formatBrowserLaunchError(error);
        resetClientReference();
        console.error('Error inicializando WhatsApp de despacho.', error);
        scheduleReconnect('error de inicio');
      }).finally(() => {
        initializing = false;
      });

      return client;
    })
    .catch((error) => {
      ready = false;
      lastQr = null;
      lastError = error?.message || 'No fue posible preparar WhatsApp de despacho.';
      initializing = false;
      console.error('Error preparando WhatsApp de despacho.', error);
    });

  return client;
}

export function getDispatchWhatsappStatus() {
  return { ready, initializing, reconnecting: Boolean(reconnectTimer), lastQr, lastError, lastReadyAt, lastAuthenticatedAt, authDataPath: resolveAuthDataPath() };
}

export async function getDispatchWhatsappStatusView(options = {}) {
  const autoStart = Boolean(options?.autoStart);
  if (autoStart && !ready && !lastQr && !initializing && !client) initDispatchWhatsappClient();
  let qrImage = null;
  if (lastQr) {
    try {
      qrImage = await QRCode.toDataURL(lastQr);
    } catch (error) {
      console.error('No fue posible generar imagen QR de WhatsApp despacho.', error);
    }
  }
  return { ready, initializing, reconnecting: Boolean(reconnectTimer), lastQr, qrImage, lastError, lastReadyAt, lastAuthenticatedAt, authDataPath: resolveAuthDataPath() };
}

export async function sendDispatchWhatsappMessage({ phone, message, context }) {
  const normalizedMessage = normalizeMessage(message);
  if (!normalizedMessage) throw buildError('El mensaje de WhatsApp no puede estar vacío.', 400);
  if (/<[^>]+>/.test(normalizedMessage)) throw buildError('El mensaje de WhatsApp no puede contener HTML.', 400);

  const activeClient = await getReadyClient();
  const recipient = await getRecipientId(activeClient, phone);
  const lockKey = reserveSendLock({ channelType: 'text', phone: recipient.normalizedPhone, payload: normalizedMessage });
  try {
    const sent = await activeClient.sendMessage(recipient.serializedId, normalizedMessage);
    rememberPendingConfirmation(recipient.normalizedPhone, context);
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

  await loadWhatsappWebModule();
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
