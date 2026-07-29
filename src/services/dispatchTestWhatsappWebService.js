import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma.js';
import {
  isAutomaticConfirmationReply,
  resolveDispatchWhatsappChatAliases
} from './dispatchWhatsappWebServiceV6.js';

const DEV_TEST_REQUEST_SOURCE = 'DEV_TEST';
const DEV_TEST_ASSIGNED_STATUS = 'DEV_TEST_ASSIGNED';
const DEV_TEST_CONFIRMED_STATUS = 'DEV_TEST_CONFIRMED';
const DEV_TEST_LINK_PENDING = 'DEV_TEST_PENDING';
const DEV_TEST_LINK_DELIVERY_UNKNOWN = 'DEV_TEST_DELIVERY_UNKNOWN';
const DEV_TEST_LINK_CONFIRMED = 'DEV_TEST_CONFIRMED';
const TEST_SENDABLE_ASSIGNMENT_STATUSES = [DEV_TEST_ASSIGNED_STATUS, DEV_TEST_CONFIRMED_STATUS];
const TEST_PENDING_LINK_STATUSES = [DEV_TEST_LINK_PENDING, DEV_TEST_LINK_DELIVERY_UNKNOWN];
const CHROMIUM_LOCK_FILES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
const RECONNECT_DELAY_MS = Math.max(1000, Number(process.env.DISPATCH_TEST_WWEB_RECONNECT_DELAY_MS || 5000));
const DUPLICATE_SEND_WINDOW_MS = Math.max(0, Number(process.env.DISPATCH_TEST_DUPLICATE_SEND_WINDOW_MS || 120000));
const CONFIRMATION_TTL_MS = Math.max(60000, Number(process.env.DISPATCH_TEST_WA_CONFIRMATION_TTL_MS || 36 * 60 * 60 * 1000));
const MAX_MESSAGE_LENGTH = 3500;

let Client = null;
let LocalAuth = null;
let modulePromise = null;
let client = null;
let initializing = false;
let ready = false;
let manualLogoutRequested = false;
let lastQr = null;
let lastError = null;
let lastReadyAt = null;
let lastAuthenticatedAt = null;
let lastInboundAt = null;
let lastConfirmationAt = null;
let reconnectTimer = null;

const inboundLocks = new Map();
const sendLocks = new Map();

function normalizeString(value, maxLength = 3500) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `57${digits}`;
  return digits;
}

function normalizeChatId(value) {
  return String(value || '').trim().toLowerCase();
}

function buildError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveAuthDataPath() {
  if (process.env.DISPATCH_TEST_WWEB_AUTH_PATH) return process.env.DISPATCH_TEST_WWEB_AUTH_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/dispatch-wweb-auth-test`;
  if (existsSync('/data')) return '/data/dispatch-wweb-auth-test';
  return './storage/dispatch-wweb-auth-test';
}

function authStorageInfo() {
  const authDataPath = path.resolve(resolveAuthDataPath());
  const railwayVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
  const relative = railwayVolume ? path.relative(path.resolve(railwayVolume), authDataPath) : '..';
  const insideVolume = Boolean(railwayVolume) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const persistent = process.env.DISPATCH_TEST_WWEB_AUTH_PERSISTENT === 'true' || insideVolume;
  return {
    authDataPath,
    authStoragePersistent: persistent,
    authStorageMode: persistent ? 'PERSISTENT' : 'EPHEMERAL',
    authStorageWarning: persistent
      ? null
      : 'La sesión WhatsApp de prueba está en almacenamiento efímero. Configura DISPATCH_TEST_WWEB_AUTH_PATH dentro del volumen de Railway.'
  };
}

function ensureAuthDataPath() {
  const dataPath = resolveAuthDataPath();
  mkdirSync(dataPath, { recursive: true });
  return dataPath;
}

function cleanupChromiumLocks(rootPath, depth = 0) {
  if (!rootPath || depth > 5 || !existsSync(rootPath)) return;
  let entries = [];
  try { entries = readdirSync(rootPath, { withFileTypes: true }); }
  catch (_error) { return; }
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      cleanupChromiumLocks(entryPath, depth + 1);
      continue;
    }
    if (CHROMIUM_LOCK_FILES.has(entry.name)) rmSync(entryPath, { force: true, recursive: true });
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
    '/usr/bin/google-chrome'
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function puppeteerOptions() {
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
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=site-per-process',
      '--disable-software-rasterizer'
    ]
  };
}

async function loadWhatsappModule() {
  if (Client && LocalAuth) return { Client, LocalAuth };
  if (!modulePromise) {
    modulePromise = import('whatsapp-web.js').then((module) => {
      const runtime = module.default || module;
      Client = runtime.Client;
      LocalAuth = runtime.LocalAuth;
      if (!Client || !LocalAuth) throw new Error('whatsapp-web.js no expuso Client o LocalAuth.');
      return { Client, LocalAuth };
    }).catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

function cleanupLocks(map, now = Date.now()) {
  for (const [key, expiresAt] of map.entries()) if (expiresAt <= now) map.delete(key);
}

function reserveSend(phone, message) {
  if (!DUPLICATE_SEND_WINDOW_MS) return null;
  cleanupLocks(sendLocks);
  const key = `${phone}|${message}`;
  const expiresAt = sendLocks.get(key) || 0;
  if (expiresAt > Date.now()) throw buildError('Este mismo mensaje de prueba ya fue enviado recientemente.', 429);
  sendLocks.set(key, Date.now() + DUPLICATE_SEND_WINDOW_MS);
  return key;
}

function inboundKey(message = {}) {
  return String(message.id?._serialized || message.id?.id || `${message.from || ''}|${message.timestamp || ''}|${message.body || ''}`);
}

function reserveInbound(message) {
  cleanupLocks(inboundLocks);
  const key = inboundKey(message);
  if (!key || (inboundLocks.get(key) || 0) > Date.now()) return false;
  inboundLocks.set(key, Date.now() + 30000);
  return true;
}

function messageText(message = {}) {
  return normalizeString(
    message.body
    || message.caption
    || message.selectedButtonId
    || message.selectedRowId
    || message._data?.body
    || message.rawData?.body,
    MAX_MESSAGE_LENGTH
  ) || '';
}

async function resolveInboundPhone(activeClient, message = {}) {
  const sender = normalizeChatId(message.from);
  if (sender.endsWith('@c.us')) return normalizePhone(sender.split('@')[0]);
  if (sender.endsWith('@lid') && typeof activeClient?.getContactLidAndPhone === 'function') {
    try {
      const rows = await activeClient.getContactLidAndPhone([sender, sender.split('@')[0]]);
      const row = (Array.isArray(rows) ? rows : []).find((item) => item?.pn || item?.phone);
      const mapped = normalizePhone(row?.pn || row?.phone);
      if (mapped) return mapped;
    } catch (_error) {}
  }
  try {
    const contact = typeof message.getContact === 'function' ? await message.getContact() : null;
    return normalizePhone(contact?.number || contact?.id?.user || contact?.id?._serialized || sender);
  } catch (_error) {
    return normalizePhone(sender);
  }
}

async function recalculateDevTestRequest(serviceRequestId) {
  const request = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { id: true, requiredWorkers: true, source: true }
  });
  if (!request || request.source !== DEV_TEST_REQUEST_SOURCE) return;
  const assigned = await prisma.dispatchAssignment.count({
    where: {
      serviceRequestId,
      status: { in: [DEV_TEST_ASSIGNED_STATUS, DEV_TEST_CONFIRMED_STATUS] }
    }
  });
  const status = assigned === 0
    ? 'DEV_TEST_PENDING'
    : assigned >= request.requiredWorkers
      ? 'DEV_TEST_COMPLETE'
      : 'DEV_TEST_PARTIAL';
  await prisma.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
}

async function findPendingConfirmation({ phone, chatId }) {
  const normalizedPhone = normalizePhone(phone);
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedPhone && !normalizedChatId) return null;
  return prisma.dispatchWhatsappConfirmation.findFirst({
    where: {
      status: { in: TEST_PENDING_LINK_STATUSES },
      expiresAt: { gte: new Date() },
      OR: [
        ...(normalizedChatId ? [{ chatId: normalizedChatId }] : []),
        ...(normalizedPhone ? [{ phone: normalizedPhone }] : [])
      ],
      assignment: {
        serviceRequest: { source: DEV_TEST_REQUEST_SOURCE },
        worker: { isTestProfile: true }
      }
    },
    include: {
      assignment: { include: { worker: true, serviceRequest: true } }
    },
    orderBy: { createdAt: 'desc' }
  });
}

async function confirmFromInbound(activeClient, message) {
  if (message.fromMe || message.id?.fromMe || message._data?.id?.fromMe) return false;
  if (!isAutomaticConfirmationReply(messageText(message))) return false;
  if (!reserveInbound(message)) return false;
  const chatId = normalizeChatId(message.from);
  const phone = await resolveInboundPhone(activeClient, message);
  const link = await findPendingConfirmation({ phone, chatId });
  if (!link?.assignment?.id) return false;

  await prisma.$transaction(async (tx) => {
    await tx.dispatchAssignment.updateMany({
      where: {
        id: link.assignment.id,
        status: DEV_TEST_ASSIGNED_STATUS,
        serviceRequest: { source: DEV_TEST_REQUEST_SOURCE },
        worker: { isTestProfile: true }
      },
      data: { status: DEV_TEST_CONFIRMED_STATUS }
    });
    await tx.dispatchWhatsappConfirmation.updateMany({
      where: {
        assignmentId: link.assignment.id,
        status: { in: TEST_PENDING_LINK_STATUSES }
      },
      data: {
        status: DEV_TEST_LINK_CONFIRMED,
        confirmationMessageId: inboundKey(message),
        confirmationReceivedAt: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date()
      }
    });
    await tx.devAuditEvent.create({
      data: {
        entityType: 'DISPATCH_DEV_TEST_WHATSAPP',
        entityId: link.assignment.id,
        entityLabel: link.assignment.worker?.fullName || 'Sujeto de prueba',
        action: 'DEV_TEST_WHATSAPP_CONFIRMED',
        actorUsername: 'whatsapp-test',
        actorRole: 'dev',
        actorSource: 'dispatch-test-whatsapp',
        metadata: { serviceRequestId: link.assignment.serviceRequestId, phoneResolved: Boolean(phone), chatId }
      }
    });
  });

  await recalculateDevTestRequest(link.assignment.serviceRequestId);
  try { await activeClient.sendMessage(chatId, 'Gracias.'); }
  catch (error) { console.warn('[dispatch-wa-test] Confirmó, pero no fue posible responder Gracias.', error?.message || error); }
  lastInboundAt = new Date().toISOString();
  lastConfirmationAt = lastInboundAt;
  return true;
}

function bindInbound(activeClient) {
  const handler = (message) => confirmFromInbound(activeClient, message)
    .catch((error) => console.error('[dispatch-wa-test] Error procesando confirmación.', error));
  activeClient.on('message', handler);
  activeClient.on('message_create', handler);
}

function scheduleReconnect(reason) {
  if (manualLogoutRequested || reconnectTimer || initializing) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!manualLogoutRequested) initDispatchTestWhatsappClient();
  }, RECONNECT_DELAY_MS);
  reconnectTimer.unref?.();
  console.warn(`[dispatch-wa-test] Reconexión programada${reason ? `: ${reason}` : ''}.`);
}

async function destroyClient(activeClient, logout = false) {
  if (!activeClient) return;
  if (logout) {
    try { await activeClient.logout(); }
    catch (_error) {}
  }
  try { await activeClient.destroy(); }
  catch (_error) {}
}

export function initDispatchTestWhatsappClient() {
  if (client || initializing) return client;
  manualLogoutRequested = false;
  const dataPath = ensureAuthDataPath();
  cleanupChromiumLocks(dataPath);
  initializing = true;
  loadWhatsappModule().then(({ Client: WhatsappClient, LocalAuth: WhatsappLocalAuth }) => {
    if (client) return;
    const activeClient = new WhatsappClient({
      authStrategy: new WhatsappLocalAuth({ clientId: 'dispatch-test', dataPath }),
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      puppeteer: puppeteerOptions()
    });
    client = activeClient;
    activeClient.on('qr', (qr) => { lastQr = qr; ready = false; lastError = null; });
    activeClient.on('authenticated', () => { lastAuthenticatedAt = new Date().toISOString(); lastError = null; });
    activeClient.on('ready', () => { ready = true; lastQr = null; lastError = null; lastReadyAt = new Date().toISOString(); });
    bindInbound(activeClient);
    activeClient.on('disconnected', (reason) => {
      ready = false;
      lastQr = null;
      lastError = reason ? `WhatsApp de prueba desconectado: ${reason}` : 'WhatsApp de prueba desconectado.';
      client = null;
      destroyClient(activeClient).finally(() => scheduleReconnect(reason));
    });
    activeClient.on('auth_failure', (message) => {
      ready = false;
      lastQr = null;
      lastError = message ? `Fallo de autenticación en WhatsApp de prueba: ${message}` : 'Fallo de autenticación en WhatsApp de prueba.';
      client = null;
      destroyClient(activeClient).finally(() => scheduleReconnect('auth_failure'));
    });
    activeClient.initialize().catch(async (error) => {
      ready = false;
      lastQr = null;
      lastError = error?.message || 'No fue posible iniciar WhatsApp de prueba.';
      client = null;
      await destroyClient(activeClient);
      scheduleReconnect('initialize_failed');
    }).finally(() => { initializing = false; });
  }).catch((error) => {
    initializing = false;
    ready = false;
    lastError = error?.message || 'No fue posible cargar WhatsApp de prueba.';
  });
  return client;
}

export function getDispatchTestWhatsappStatus() {
  return {
    ready,
    initializing,
    reconnecting: Boolean(reconnectTimer),
    manualLogoutRequested,
    lastQr,
    lastError,
    lastReadyAt,
    lastAuthenticatedAt,
    lastInboundAt,
    lastConfirmationAt,
    runtimeProfile: 'DEV_TEST',
    ...authStorageInfo()
  };
}

export async function getDispatchTestWhatsappStatusView({ autoStart = false } = {}) {
  if (autoStart && !client && !initializing && !ready) initDispatchTestWhatsappClient();
  let qrImage = null;
  if (lastQr) {
    try { qrImage = await QRCode.toDataURL(lastQr); }
    catch (error) { lastError = error?.message || 'No fue posible generar el QR de prueba.'; }
  }
  return { ...getDispatchTestWhatsappStatus(), qrImage };
}

export async function closeDispatchTestWhatsappSession() {
  manualLogoutRequested = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const activeClient = client;
  client = null;
  ready = false;
  initializing = false;
  lastQr = null;
  lastError = 'Sesión de WhatsApp de prueba cerrada. Escanea un QR nuevo para volver a vincularla.';
  await destroyClient(activeClient, true);
  return getDispatchTestWhatsappStatus();
}

async function validateTestContext({ phone, context = {} }) {
  const assignmentId = normalizeString(context.assignmentId, 120);
  const serviceRequestId = normalizeString(context.serviceRequestId, 120);
  const workerId = normalizeString(context.workerId, 120);
  if (!assignmentId || !serviceRequestId || !workerId) throw buildError('Falta el contexto completo de la asignación de prueba.');
  const assignment = await prisma.dispatchAssignment.findFirst({
    where: {
      id: assignmentId,
      serviceRequestId,
      workerId,
      status: { in: TEST_SENDABLE_ASSIGNMENT_STATUSES },
      serviceRequest: { source: DEV_TEST_REQUEST_SOURCE },
      worker: { isTestProfile: true }
    },
    include: { worker: true, serviceRequest: true }
  });
  if (!assignment) throw buildError('La asignación no pertenece al entorno DEV o ya no está disponible.', 409);
  if (normalizePhone(assignment.worker?.phone) !== normalizePhone(phone)) {
    throw buildError('El número no corresponde al sujeto de prueba seleccionado.', 409);
  }
  return assignment;
}

export async function sendDispatchTestWhatsappMessage({ phone, message, context }) {
  const normalizedMessage = normalizeString(message, MAX_MESSAGE_LENGTH);
  if (!normalizedMessage) throw buildError('El mensaje de prueba no puede estar vacío.');
  if (/<[^>]+>/.test(normalizedMessage)) throw buildError('El mensaje no puede contener HTML.');
  const assignment = await validateTestContext({ phone, context });
  if (!ready || !client) throw buildError('WhatsApp de prueba no está conectado. Vincula la segunda cuenta mediante el QR.', 503);
  const normalizedPhone = normalizePhone(phone);
  const numberId = await client.getNumberId(normalizedPhone);
  if (!numberId?._serialized) throw buildError('El número del sujeto de prueba no está disponible en WhatsApp.');
  const sendLock = reserveSend(normalizedPhone, normalizedMessage);
  const aliases = await resolveDispatchWhatsappChatAliases(client, {
    phone: normalizedPhone,
    chatIds: [numberId._serialized]
  });
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  const chatIds = aliases.length ? aliases : [numberId._serialized];
  const created = await prisma.$transaction(async (tx) => {
    const primary = await tx.dispatchWhatsappConfirmation.create({
      data: {
        assignmentId: assignment.id,
        serviceRequestId: assignment.serviceRequestId,
        phone: normalizedPhone,
        chatId: chatIds[0],
        status: DEV_TEST_LINK_PENDING,
        expiresAt
      }
    });
    if (chatIds.length > 1) {
      await tx.dispatchWhatsappConfirmation.createMany({
        data: chatIds.slice(1).map((chatId) => ({
          assignmentId: assignment.id,
          serviceRequestId: assignment.serviceRequestId,
          phone: normalizedPhone,
          chatId,
          status: DEV_TEST_LINK_PENDING,
          expiresAt
        }))
      });
    }
    return primary;
  });

  try {
    const sent = await client.sendMessage(numberId._serialized, normalizedMessage);
    const providerMessageId = sent?.id?._serialized || sent?.id?.id || null;
    await prisma.dispatchWhatsappConfirmation.updateMany({
      where: {
        assignmentId: assignment.id,
        status: DEV_TEST_LINK_PENDING,
        createdAt: { gte: created.createdAt }
      },
      data: { providerMessageId }
    });
    return { phone: normalizedPhone, providerMessageId };
  } catch (error) {
    sendLocks.delete(sendLock);
    await prisma.dispatchWhatsappConfirmation.updateMany({
      where: {
        assignmentId: assignment.id,
        status: DEV_TEST_LINK_PENDING,
        createdAt: { gte: created.createdAt }
      },
      data: { status: DEV_TEST_LINK_DELIVERY_UNKNOWN }
    });
    throw error;
  }
}
