import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma.js';
import { recalculateDispatchServiceRequestStatus } from './dispatchOperationalCoverage.js';

const MAX_MESSAGE_LENGTH = 3500;
const NOT_CONNECTED_MESSAGE = 'WhatsApp de despacho no está conectado. Escanea el QR e intenta nuevamente.';
const LOGGED_OUT_MESSAGE = 'Sesión de WhatsApp despacho cerrada. Escanea un nuevo QR para volver a conectar.';
const DUPLICATE_SEND_WINDOW_MS = Number(process.env.DISPATCH_DUPLICATE_SEND_WINDOW_MS || 120000);
const RECONNECT_DELAY_MS = Number(process.env.DISPATCH_WWEB_RECONNECT_DELAY_MS || 5000);
const CONFIRMATION_MEMORY_TTL_MS = Number(process.env.DISPATCH_WA_CONFIRMATION_MEMORY_TTL_MS || 36 * 60 * 60 * 1000);
const INBOUND_LOCK_TTL_MS = 30000;
const CLIENT_DESTROY_TIMEOUT_MS = Math.max(1000, Number(process.env.DISPATCH_WWEB_DESTROY_TIMEOUT_MS || 5000));
const PENDING_RECONCILIATION_INTERVAL_MS = Math.max(15000, Number(process.env.DISPATCH_WA_RECONCILE_INTERVAL_MS || 30000));
const PENDING_RECONCILIATION_LIMIT = Math.max(1, Number(process.env.DISPATCH_WA_RECONCILE_LIMIT || 200));
const PENDING_RECONCILIATION_MESSAGES_PER_CHAT = Math.max(1, Number(process.env.DISPATCH_WA_RECONCILE_MESSAGES_PER_CHAT || 20));
const CHROMIUM_LOCK_FILES = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
const PENDING_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING'];
const RECOVERABLE_CONFIRMATION_LINK_STATUSES = ['PENDING', 'DELIVERY_UNKNOWN'];
const CONFIRMED_REPLY_PENDING_STATUS = 'CONFIRMED_REPLY_PENDING';
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const AUTOMATIC_CONFIRMATION_REPLY = 'Gracias.';
const CONNECTED_CLIENT_STATE = 'CONNECTED';

let Client = null;
let LocalAuth = null;
let MessageMedia = null;
let whatsappModuleLoadPromise = null;
let client = null;
let initializing = false;
let ready = false;
let manualLogoutRequested = false;
let lastQr = null;
let lastError = null;
let lastReadyAt = null;
let lastAuthenticatedAt = null;
let reconnectTimer = null;
let pendingReconciliationTimer = null;
let pendingReconciliationRunning = false;
let lastPendingReconciliationAt = null;
let lastPendingReconciliationProcessed = 0;
let lastInboundAt = null;
let lastConfirmationAt = null;
let lastHealthCheckAt = null;
let lastHealthState = null;
let lastHealthError = null;

const recentSendLocks = new Map();
const pendingConfirmationByPhone = new Map();
const pendingConfirmationByChatId = new Map();
const inboundLocks = new Map();

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

function normalizeChatId(value) {
  return String(value || '').trim().toLowerCase();
}

function chatIdsFromSentMessage(recipient, sent) {
  return [
    recipient?.serializedId,
    sent?.id?.remote,
    sent?.id?.participant,
    sent?.to,
    sent?.from,
    sent?._data?.id?.remote,
    sent?._data?.to,
    sent?._data?.from
  ].map(normalizeChatId).filter(Boolean);
}

export async function resolveDispatchWhatsappChatAliases(activeClient, { phone = '', chatIds = [] } = {}) {
  const aliases = new Set(chatIds.map(normalizeChatId).filter(Boolean));
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone) aliases.add(`${normalizedPhone}@c.us`);

  if (normalizedPhone && typeof activeClient?.getNumberId === 'function') {
    try {
      const numberId = await activeClient.getNumberId(normalizedPhone);
      const serialized = normalizeChatId(numberId?._serialized);
      if (serialized) aliases.add(serialized);
    } catch (error) {
      console.warn('[dispatch-wa] No fue posible resolver el identificador telefónico del chat.', error?.message || error);
    }
  }

  const seeds = [...aliases].filter(isSupportedSenderId).slice(0, 10);
  if (seeds.length && typeof activeClient?.getContactLidAndPhone === 'function') {
    try {
      const rows = await activeClient.getContactLidAndPhone(seeds);
      for (const row of Array.isArray(rows) ? rows : []) {
        for (const value of [row?.lid, row?.pn, row?.phone]) {
          const normalized = normalizeChatId(value);
          if (normalized) aliases.add(normalized);
        }
      }
    } catch (error) {
      console.warn('[dispatch-wa] No fue posible ampliar los alias PN/LID del chat.', error?.message || error);
    }
  }

  return [...aliases].filter(isSupportedSenderId);
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

function messageTimestamp(message = {}) {
  return Number(message.timestamp || message._data?.t || message.rawData?.timestamp || 0);
}

export function isAutomaticConfirmationReply(value) {
  const text = normalizeConfirmationText(value);
  return text === 'confirmado'
    || text === 'confirmada'
    || text === 'confirmo'
    || text === 'si confirmado'
    || text === 'si confirmo'
    || text === 'si'
    || text === 'ok'
    || text === 'okay'
    || text === 'listo'
    || text === 'recibido'
    || text === 'enterado'
    || /^confirmad[oa]\b/.test(text)
    || /^confirmo\b/.test(text)
    || /^si\b.*\b(confirmad[oa]|confirmo|asisto|voy|listo|recibido)\b/.test(text);
}

function firstString(values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

function confirmationTextFromMessage(message = {}) {
  return firstString([
    message.body,
    message.caption,
    message.selectedButtonId,
    message.selectedRowId,
    message.buttonText,
    message.rawData?.body,
    message.rawData?.caption,
    message.rawData?.selectedButtonId,
    message.rawData?.selectedRowId,
    message.rawData?.buttonText,
    message._data?.body,
    message._data?.caption,
    message._data?.selectedButtonId,
    message._data?.selectedRowId,
    message._data?.buttonText,
    message._data?.hydratedButtonText
  ]);
}

function normalizeWhatsappSenderId(senderId) {
  const raw = String(senderId || '').split('@')[0];
  return normalizePhone(raw);
}

function isSupportedSenderId(senderId) {
  const sender = String(senderId || '');
  return sender.endsWith('@c.us') || sender.endsWith('@lid');
}

async function getInboundContact(message = {}) {
  try {
    if (typeof message.getContact === 'function') return await message.getContact();
  } catch (error) {
    console.warn('[dispatch-wa] No fue posible resolver contacto de respuesta entrante.', error?.message || error);
  }
  return null;
}

async function resolveInboundPhone(message = {}, activeClient = client, resolvedContact = null) {
  const sender = String(message.from || '');
  if (sender.endsWith('@c.us')) return normalizeWhatsappSenderId(sender);

  if (sender.endsWith('@lid') && typeof activeClient?.getContactLidAndPhone === 'function') {
    try {
      const lid = sender.split('@')[0];
      const rows = await activeClient.getContactLidAndPhone([lid, sender]);
      const row = (Array.isArray(rows) ? rows : []).find((item) => item?.pn || item?.phone);
      const mappedPhone = normalizePhone(row?.pn || row?.phone);
      if (mappedPhone) return mappedPhone;
    } catch (error) {
      console.warn('[dispatch-wa] No fue posible mapear LID a teléfono.', error?.message || error);
    }
  }

  const contact = resolvedContact || await getInboundContact(message);
  return normalizePhone(
    contact?.number
    || contact?.id?.user
    || contact?.id?._serialized
    || message.rawData?.sender?.id
    || message.rawData?.author
    || message._data?.sender?.id
    || message._data?.author
    || sender
  );
}

function inboundKey(message = {}) {
  return String(message.id?._serialized || message.id?.id || `${message.from || ''}|${message.timestamp || ''}|${confirmationTextFromMessage(message)}`);
}

function cleanupInboundLocks(now = Date.now()) {
  for (const [key, value] of inboundLocks.entries()) {
    if (value.expiresAt <= now) inboundLocks.delete(key);
  }
}

function reserveInbound(message) {
  const now = Date.now();
  cleanupInboundLocks(now);
  const key = inboundKey(message);
  if (!key) return false;
  if (inboundLocks.get(key)?.expiresAt > now) return false;
  inboundLocks.set(key, { expiresAt: now + INBOUND_LOCK_TTL_MS });
  return true;
}

function releaseInbound(message) {
  const key = inboundKey(message);
  if (key) inboundLocks.delete(key);
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

function cleanupExpiredPendingConfirmations(now = Date.now()) {
  for (const [phone, value] of pendingConfirmationByPhone.entries()) {
    if (value.expiresAt <= now) pendingConfirmationByPhone.delete(phone);
  }
  for (const [chatId, value] of pendingConfirmationByChatId.entries()) {
    if (value.expiresAt <= now) pendingConfirmationByChatId.delete(chatId);
  }
}

function buildPendingConfirmationValue(phone, context = {}) {
  const normalizedPhone = normalizePhone(phone);
  const assignmentId = String(context?.assignmentId || '').trim();
  const serviceRequestId = String(context?.serviceRequestId || '').trim();
  if (!normalizedPhone || !assignmentId || !serviceRequestId) {
    console.warn(`[dispatch-wa] Mensaje enviado sin contexto completo de confirmación. phonePresent=${normalizedPhone ? 'yes' : 'no'} assignment=${assignmentId || 'missing'} request=${serviceRequestId || 'missing'}`);
    return null;
  }
  return {
    assignmentId,
    serviceRequestId,
    createdAtMs: Date.now(),
    expiresAt: Date.now() + CONFIRMATION_MEMORY_TTL_MS
  };
}

function rememberPendingConfirmation(phone, context = {}, chatIds = []) {
  const normalizedPhone = normalizePhone(phone);
  const value = buildPendingConfirmationValue(normalizedPhone, context);
  if (!value) return null;
  pendingConfirmationByPhone.set(normalizedPhone, value);
  const normalizedChatIds = chatIds.map(normalizeChatId).filter(Boolean);
  normalizedChatIds.forEach((chatId) => pendingConfirmationByChatId.set(chatId, value));
  console.log(`[dispatch-wa] Confirmación pendiente recordada. assignment=${value.assignmentId} phoneLinked=yes chatAliases=${normalizedChatIds.length}.`);
  return { ...value, phone: normalizedPhone, chatIds: normalizedChatIds };
}

async function preparePendingConfirmationLink({ phone, context = {}, chatId = '', chatIds = [] }) {
  const normalizedPhone = normalizePhone(phone);
  const aliases = [...new Set([chatId, ...chatIds].map(normalizeChatId).filter(Boolean))];
  const primaryChatId = aliases[0] || '';
  const pendingValue = buildPendingConfirmationValue(normalizedPhone, context);
  if (!pendingValue?.assignmentId || !pendingValue?.serviceRequestId || !primaryChatId) {
    throw buildError('No fue posible preparar el contexto persistente de confirmación.', 503);
  }

  const commonData = {
    assignmentId: pendingValue.assignmentId,
    serviceRequestId: pendingValue.serviceRequestId,
    phone: normalizedPhone,
    status: 'PENDING',
    expiresAt: new Date(pendingValue.expiresAt)
  };

  try {
    const link = await prisma.$transaction(async (tx) => {
      const primary = await tx.dispatchWhatsappConfirmation.create({
        data: { ...commonData, chatId: primaryChatId }
      });
      const extraRows = aliases.slice(1).map((alias) => ({ ...commonData, chatId: alias }));
      if (extraRows.length) await tx.dispatchWhatsappConfirmation.createMany({ data: extraRows });
      return primary;
    });
    const remembered = rememberPendingConfirmation(normalizedPhone, context, aliases);
    return { ...remembered, linkId: link.id, primaryChatId, chatIds: aliases };
  } catch (error) {
    console.error('[dispatch-wa] No fue posible guardar el contexto antes del envío.', error?.message || error);
    throw buildError('No se envió WhatsApp porque no fue posible guardar el contexto de confirmación. Intenta nuevamente.', 503);
  }
}

async function finalizePendingConfirmationLink({ pending, chatIds = [], providerMessageId = null }) {
  if (!pending?.linkId) return;
  const normalizedChatIds = [...new Set(chatIds.map(normalizeChatId).filter(Boolean))];
  const existingChatIds = new Set((pending.chatIds || [pending.primaryChatId]).map(normalizeChatId).filter(Boolean));
  try {
    await prisma.dispatchWhatsappConfirmation.update({
      where: { id: pending.linkId },
      data: { providerMessageId }
    });
    const extraRows = normalizedChatIds
      .filter((chatId) => !existingChatIds.has(chatId))
      .map((chatId) => ({
        assignmentId: pending.assignmentId,
        serviceRequestId: pending.serviceRequestId,
        phone: pending.phone,
        chatId,
        providerMessageId,
        status: 'PENDING',
        expiresAt: new Date(pending.expiresAt)
      }));
    if (extraRows.length) await prisma.dispatchWhatsappConfirmation.createMany({ data: extraRows });
    rememberPendingConfirmation(pending.phone, pending, [...existingChatIds, ...normalizedChatIds]);
  } catch (error) {
    // Los alias persistidos antes del envío mantienen recuperable la confirmación.
    console.warn('[dispatch-wa] El mensaje fue enviado, pero no fue posible enriquecer todos los identificadores del contexto.', error?.message || error);
  }
}

async function markPendingConfirmationDeliveryUnknown(pending) {
  if (!pending?.linkId) return;
  try {
    await prisma.dispatchWhatsappConfirmation.updateMany({
      where: { id: pending.linkId, status: 'PENDING' },
      data: { status: 'DELIVERY_UNKNOWN' }
    });
  } catch (error) {
    console.warn('[dispatch-wa] No fue posible conservar el estado de entrega incierta.', error?.message || error);
  }
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
        if (!Client || !LocalAuth || !MessageMedia) throw new Error('El módulo whatsapp-web.js no expuso Client, LocalAuth o MessageMedia.');
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

export function isPathWithinRoot(rootPath, targetPath) {
  if (!rootPath || !targetPath) return false;
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function authStorageInfo() {
  const authDataPath = path.resolve(resolveAuthDataPath());
  const explicitPersistentPath = process.env.DISPATCH_WWEB_AUTH_PERSISTENT === 'true';
  const railwayVolumeMountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
  const authPathInsideRailwayVolume = isPathWithinRoot(railwayVolumeMountPath, authDataPath);
  const authStoragePersistent = explicitPersistentPath || authPathInsideRailwayVolume;
  return {
    authDataPath,
    authStoragePersistent,
    authStorageMode: authStoragePersistent ? 'PERSISTENT' : 'EPHEMERAL',
    authStorageWarning: authStoragePersistent
      ? null
      : 'La sesión de WhatsApp está en almacenamiento efímero. Monta un volumen Railway, ubica LocalAuth dentro del volumen y desactiva Serverless para operación continua.'
  };
}

function ensureAuthDataPath() {
  const dataPath = resolveAuthDataPath();
  try { mkdirSync(dataPath, { recursive: true }); }
  catch (error) { console.warn('No fue posible crear/verificar carpeta de sesión de WhatsApp despacho.', error); }
  return dataPath;
}

function cleanupChromiumProfileLocks(rootPath, depth = 0) {
  if (!rootPath || depth > 5 || !existsSync(rootPath)) return;
  let entries = [];
  try { entries = readdirSync(rootPath, { withFileTypes: true }); }
  catch (error) { console.warn(`No fue posible leer carpeta de sesión WhatsApp despacho: ${rootPath}`, error); return; }
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) { cleanupChromiumProfileLocks(entryPath, depth + 1); continue; }
    if (!CHROMIUM_LOCK_FILES.has(entry.name)) continue;
    try { rmSync(entryPath, { force: true, recursive: true }); console.log(`Lock stale de Chromium eliminado: ${entryPath}`); }
    catch (error) { console.warn(`No fue posible eliminar lock stale de Chromium: ${entryPath}`, error); }
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

function buildPuppeteerOptions() {
  const executablePath = resolveChromeExecutablePath();
  if (!executablePath) {
    lastError = 'No se encontró Chrome/Chromium en el servidor para iniciar la sesión de WhatsApp despacho.';
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
  if (manualLogoutRequested || reconnectTimer || initializing) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (manualLogoutRequested) return;
    console.log(`Reintentando conexión de WhatsApp despacho${reason ? ` (${reason})` : ''}.`);
    initDispatchWhatsappClient();
  }, RECONNECT_DELAY_MS);
}

async function resetClientReference() {
  stopPendingConfirmationReconciliation();
  const oldClient = client;
  client = null;
  initializing = false;
  ready = false;
  lastQr = null;
  await destroyClientWithoutLogout(oldClient);
}

async function destroyClientWithoutLogout(activeClient) {
  if (!activeClient) return;
  let timeoutId = null;
  try {
    await Promise.race([
      Promise.resolve(activeClient.destroy()),
      new Promise((resolve) => {
        timeoutId = setTimeout(resolve, CLIENT_DESTROY_TIMEOUT_MS);
        timeoutId.unref?.();
      })
    ]);
  } catch (error) {
    console.warn('[dispatch-wa] No fue posible destruir completamente el cliente durante la recuperación.', error?.message || error);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function restartDispatchWhatsappClient(reason = 'recuperación automática') {
  if (manualLogoutRequested) return getDispatchWhatsappStatus();
  clearReconnectTimer();
  stopPendingConfirmationReconciliation();
  const oldClient = client;
  client = null;
  initializing = false;
  ready = false;
  lastQr = null;
  lastError = null;
  await destroyClientWithoutLogout(oldClient);
  const dataPath = ensureAuthDataPath();
  cleanupChromiumProfileLocks(dataPath);
  console.warn(`[dispatch-wa] Reiniciando cliente sin cerrar la sesión persistida. reason=${reason}`);
  initDispatchWhatsappClient();
  return getDispatchWhatsappStatus();
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
  return recalculateDispatchServiceRequestStatus(prisma, serviceRequestId);
}

function isMessageAfterPendingContext(message = {}, pending = {}) {
  const inboundTimestamp = messageTimestamp(message);
  if (!inboundTimestamp || !pending?.createdAtMs) return true;
  return inboundTimestamp * 1000 >= pending.createdAtMs - 5000;
}

async function findPendingAssignmentFromMemory(phone, message = {}) {
  cleanupExpiredPendingConfirmations();
  const remembered = pendingConfirmationByPhone.get(phone);
  if (!remembered?.assignmentId || !isMessageAfterPendingContext(message, remembered)) return null;
  const assignment = await prisma.dispatchAssignment.findFirst({ where: { id: remembered.assignmentId, serviceRequestId: remembered.serviceRequestId, status: { in: PENDING_ASSIGNMENT_STATUSES } }, include: { worker: true } });
  if (!assignment) return null;
  if (normalizePhone(assignment.worker?.phone) !== phone) return null;
  return assignment;
}

async function findPendingAssignmentFromChatId(chatId, message = {}) {
  cleanupExpiredPendingConfirmations();
  const remembered = pendingConfirmationByChatId.get(normalizeChatId(chatId));
  if (!remembered?.assignmentId || !isMessageAfterPendingContext(message, remembered)) return null;
  return prisma.dispatchAssignment.findFirst({
    where: {
      id: remembered.assignmentId,
      serviceRequestId: remembered.serviceRequestId,
      status: { in: PENDING_ASSIGNMENT_STATUSES }
    },
    include: { worker: true }
  });
}

async function latestPendingConfirmationLink(where) {
  return prisma.dispatchWhatsappConfirmation.findFirst({
    where: { status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES }, ...where },
    orderBy: { createdAt: 'desc' }
  });
}

async function findPersistedPendingAssignmentByLink({ phone = '', chatId = '', message = {} } = {}) {
  const inboundTimestamp = messageTimestamp(message);
  const sentBeforeInbound = inboundTimestamp ? { createdAt: { lte: new Date((inboundTimestamp * 1000) + 5000) } } : {};
  const normalizedPhone = normalizePhone(phone);
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedPhone && !normalizedChatId) return null;

  const link = (normalizedChatId ? await latestPendingConfirmationLink({ chatId: normalizedChatId, ...sentBeforeInbound }) : null)
    || (normalizedPhone ? await latestPendingConfirmationLink({ phone: normalizedPhone, ...sentBeforeInbound }) : null);
  if (!link?.assignmentId || !link?.serviceRequestId) return null;

  const assignment = await prisma.dispatchAssignment.findFirst({
    where: { id: link.assignmentId, serviceRequestId: link.serviceRequestId, status: { in: PENDING_ASSIGNMENT_STATUSES } },
    include: { worker: true }
  });
  if (!assignment) return null;
  if (normalizedPhone && normalizePhone(assignment.worker?.phone) !== normalizedPhone) return null;
  return assignment;
}

async function setPersistedConfirmationLinksStatus({ assignmentId, status = 'CONFIRMED' } = {}) {
  if (!assignmentId) return;
  try {
    await prisma.dispatchWhatsappConfirmation.updateMany({
      where: {
        assignmentId,
        status: { in: [...RECOVERABLE_CONFIRMATION_LINK_STATUSES, CONFIRMED_REPLY_PENDING_STATUS] }
      },
      data: { status }
    });
  } catch (error) {
    console.warn('[dispatch-wa] No fue posible actualizar todos los contextos persistidos de confirmación.', error?.message || error);
  }
}

export async function claimDispatchAssignmentConfirmation({ assignment, phone = '', chatId = '', prismaClient = prisma } = {}) {
  if (!assignment?.id) return { assignmentConfirmed: false, shouldReply: false, repaired: false };
  return prismaClient.$transaction(async (tx) => {
    const updated = await tx.dispatchAssignment.updateMany({
      where: { id: assignment.id, status: { in: PENDING_ASSIGNMENT_STATUSES } },
      data: { status: CONFIRMED_ASSIGNMENT_STATUS }
    });

    if (updated.count) {
      const links = await tx.dispatchWhatsappConfirmation.updateMany({
        where: { assignmentId: assignment.id, status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES } },
        data: { status: CONFIRMED_REPLY_PENDING_STATUS }
      });
      if (!links.count) {
        await tx.dispatchWhatsappConfirmation.create({
          data: {
            assignmentId: assignment.id,
            serviceRequestId: assignment.serviceRequestId,
            phone: normalizePhone(phone) || null,
            chatId: normalizeChatId(chatId) || null,
            status: CONFIRMED_REPLY_PENDING_STATUS,
            expiresAt: new Date(Date.now() + CONFIRMATION_MEMORY_TTL_MS)
          }
        });
      }
      return { assignmentConfirmed: true, shouldReply: true, repaired: false };
    }

    const current = await tx.dispatchAssignment.findUnique({
      where: { id: assignment.id },
      select: { status: true }
    });
    if (current?.status !== CONFIRMED_ASSIGNMENT_STATUS) {
      return { assignmentConfirmed: false, shouldReply: false, repaired: false };
    }

    const repaired = await tx.dispatchWhatsappConfirmation.updateMany({
      where: { assignmentId: assignment.id, status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES } },
      data: { status: CONFIRMED_REPLY_PENDING_STATUS }
    });
    return { assignmentConfirmed: false, shouldReply: repaired.count > 0, repaired: repaired.count > 0 };
  });
}

async function sendAutomaticConfirmationReply(activeClient, chatId) {
  try {
    await activeClient.sendMessage(chatId, AUTOMATIC_CONFIRMATION_REPLY);
    return true;
  } catch (firstError) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      await activeClient.sendMessage(chatId, AUTOMATIC_CONFIRMATION_REPLY);
      return true;
    } catch (secondError) {
      console.error('[dispatch-wa] La asignación fue confirmada, pero no fue posible enviar Gracias.', secondError?.message || secondError || firstError);
      return false;
    }
  }
}

async function applyAssignmentConfirmation({ activeClient, assignment, phone = '', chatId = '', eventName = 'message' } = {}) {
  if (!assignment?.id || !chatId) return false;
  const claim = await claimDispatchAssignmentConfirmation({ assignment, phone, chatId });
  if (!claim.shouldReply) return false;
  if (claim.assignmentConfirmed) await recalculateServiceRequestStatus(assignment.serviceRequestId);
  if (phone) pendingConfirmationByPhone.delete(phone);
  pendingConfirmationByChatId.delete(normalizeChatId(chatId));
  const automaticReplySent = await sendAutomaticConfirmationReply(activeClient, chatId);
  if (automaticReplySent) {
    await setPersistedConfirmationLinksStatus({ assignmentId: assignment.id, status: 'CONFIRMED' });
  }
  lastConfirmationAt = new Date().toISOString();
  console.log(`[dispatch-wa] Confirmación automática registrada para assignment=${assignment.id} event=${eventName} thanks=${automaticReplySent ? 'sent' : 'pending'} repaired=${claim.repaired ? 'yes' : 'no'}.`);
  return true;
}

async function resolveAssignmentForInboundConfirmation({ phone = '', senders = [], message = {} } = {}) {
  const normalizedSenders = [...new Set(senders.map(normalizeChatId).filter(Boolean))];
  for (const sender of normalizedSenders) {
    const assignment = await findPendingAssignmentFromChatId(sender, message)
      || await findPersistedPendingAssignmentByLink({ phone, chatId: sender, message });
    if (assignment) return assignment;
  }
  return phone ? await findPendingAssignmentFromMemory(phone, message) : null;
}

async function confirmAssignmentFromInboundMessage(activeClient, message, eventName = 'message') {
  if (message?.fromMe) return false;
  const sender = String(message?.from || '');
  if (!isSupportedSenderId(sender)) return false;
  const replyText = confirmationTextFromMessage(message);
  if (!isAutomaticConfirmationReply(replyText)) return false;
  lastInboundAt = new Date().toISOString();
  const contact = await getInboundContact(message);
  const phone = await resolveInboundPhone(message, activeClient, contact);
  const senders = [
    sender,
    contact?.id?._serialized,
    message.rawData?.author,
    message.rawData?.sender?.id,
    message._data?.author,
    message._data?.sender?.id
  ];
  const assignment = await resolveAssignmentForInboundConfirmation({ phone, senders, message });
  if (!assignment) {
    console.warn(`[dispatch-wa] Se recibió una confirmación sin contexto pendiente. senderType=${sender.split('@')[1] || 'unknown'} event=${eventName} phoneResolved=${phone ? 'yes' : 'no'}.`);
    return false;
  }
  if (!reserveInbound(message)) return false;
  try {
    return await applyAssignmentConfirmation({ activeClient, assignment, phone, chatId: sender, eventName });
  } catch (error) {
    releaseInbound(message);
    throw error;
  }
}

function bindInboundMessageListeners(activeClient) {
  const handler = (eventName) => (message) => {
    confirmAssignmentFromInboundMessage(activeClient, message, eventName).catch((error) => console.error(`[dispatch-wa] Error procesando respuesta entrante (${eventName}).`, error));
  };
  activeClient.on('message', handler('message'));
  activeClient.on('message_create', handler('message_create'));
}


export function selectLatestPendingConfirmationTargets(links = []) {
  const byAssignment = new Map();
  for (const link of links) {
    if (!link?.assignmentId) continue;
    const current = byAssignment.get(link.assignmentId);
    const linkTime = new Date(link.createdAt || 0).getTime();
    const currentTime = new Date(current?.createdAt || 0).getTime();
    if (!current || linkTime > currentTime) byAssignment.set(link.assignmentId, link);
  }
  return [...byAssignment.values()];
}

function isMessageAfterPersistedLink(message = {}, link = {}) {
  const timestamp = messageTimestamp(message);
  if (!timestamp || !link?.createdAt) return true;
  return timestamp * 1000 >= new Date(link.createdAt).getTime() - 5000;
}

async function reconciliationChatIds(activeClient, link = {}) {
  return resolveDispatchWhatsappChatAliases(activeClient, {
    phone: link.phone,
    chatIds: [link.chatId]
  });
}

async function processPersistedConfirmationTarget(activeClient, link) {
  if (!activeClient || !link?.assignmentId) return 0;
  const chatIds = await reconciliationChatIds(activeClient, link);
  for (const chatId of chatIds) {
    try {
      if (typeof activeClient.getChatById !== 'function') continue;
      const chat = await activeClient.getChatById(chatId);
      if (!chat || typeof chat.fetchMessages !== 'function') continue;
      const messages = await chat.fetchMessages({
        limit: PENDING_RECONCILIATION_MESSAGES_PER_CHAT,
        fromMe: false
      });
      for (const message of sortedMessages(messages)) {
        if (!isMessageAfterPersistedLink(message, link)) continue;
        if (await confirmAssignmentFromInboundMessage(activeClient, message, 'persisted_reconciliation')) return 1;
      }
    } catch (error) {
      console.warn(`[dispatch-wa] No fue posible reconciliar un chat pendiente. chatType=${chatId.split('@')[1] || 'unknown'}.`, error?.message || error);
    }
  }
  return 0;
}

async function repairConfirmedAssignmentsAwaitingReply() {
  const orphanedLinks = await prisma.dispatchWhatsappConfirmation.findMany({
    where: {
      status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES },
      assignment: { status: CONFIRMED_ASSIGNMENT_STATUS }
    },
    select: { assignmentId: true, createdAt: true, id: true },
    orderBy: { createdAt: 'desc' },
    take: PENDING_RECONCILIATION_LIMIT
  });
  const targets = selectLatestPendingConfirmationTargets(orphanedLinks);
  let repaired = 0;
  for (const target of targets) {
    const result = await prisma.dispatchWhatsappConfirmation.updateMany({
      where: { assignmentId: target.assignmentId, status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES } },
      data: { status: CONFIRMED_REPLY_PENDING_STATUS }
    });
    if (result.count) repaired += 1;
  }
  return repaired;
}

async function retryPendingAutomaticReplies(activeClient) {
  if (!activeClient) return 0;
  const pendingReplyLinks = await prisma.dispatchWhatsappConfirmation.findMany({
    where: { status: CONFIRMED_REPLY_PENDING_STATUS },
    select: {
      id: true,
      assignmentId: true,
      serviceRequestId: true,
      phone: true,
      chatId: true,
      createdAt: true
    },
    orderBy: { createdAt: 'desc' },
    take: PENDING_RECONCILIATION_LIMIT
  });
  const targets = selectLatestPendingConfirmationTargets(pendingReplyLinks);
  let sentCount = 0;
  for (const target of targets) {
    const chatIds = await reconciliationChatIds(activeClient, target);
    for (const chatId of chatIds) {
      if (!await sendAutomaticConfirmationReply(activeClient, chatId)) continue;
      await setPersistedConfirmationLinksStatus({ assignmentId: target.assignmentId, status: 'CONFIRMED' });
      sentCount += 1;
      break;
    }
  }
  return sentCount;
}

async function processPersistedPendingConfirmations(activeClient, reason = 'interval') {
  if (!activeClient || pendingReconciliationRunning) return 0;
  pendingReconciliationRunning = true;
  let processed = 0;
  let repliesRetried = 0;
  try {
    const links = await prisma.dispatchWhatsappConfirmation.findMany({
      where: { status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES } },
      select: {
        id: true,
        assignmentId: true,
        serviceRequestId: true,
        phone: true,
        chatId: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' },
      take: PENDING_RECONCILIATION_LIMIT
    });
    const targets = selectLatestPendingConfirmationTargets(links);
    for (const target of targets) processed += await processPersistedConfirmationTarget(activeClient, target);
    const orphanedRepliesRepaired = await repairConfirmedAssignmentsAwaitingReply();
    repliesRetried = await retryPendingAutomaticReplies(activeClient);
    if (orphanedRepliesRepaired) console.log(`[dispatch-wa] Respuestas automáticas huérfanas reparadas=${orphanedRepliesRepaired}.`);
    lastPendingReconciliationAt = new Date().toISOString();
    lastPendingReconciliationProcessed = processed + repliesRetried;
    console.log(`[dispatch-wa] Reconciliación persistente finalizada. reason=${reason} pendientes=${targets.length} confirmaciones=${processed} graciasReintentados=${repliesRetried}.`);
    return processed + repliesRetried;
  } catch (error) {
    console.warn('[dispatch-wa] No fue posible reconciliar confirmaciones persistidas.', error?.message || error);
    return processed;
  } finally {
    pendingReconciliationRunning = false;
  }
}

function stopPendingConfirmationReconciliation() {
  if (pendingReconciliationTimer) clearInterval(pendingReconciliationTimer);
  pendingReconciliationTimer = null;
  pendingReconciliationRunning = false;
}

function startPendingConfirmationReconciliation(activeClient) {
  stopPendingConfirmationReconciliation();
  const run = (reason) => {
    if (!ready || client !== activeClient) return;
    processPersistedPendingConfirmations(activeClient, reason).catch((error) => {
      console.error('[dispatch-wa] Error en reconciliación persistente.', error);
    });
  };
  run('ready');
  pendingReconciliationTimer = setInterval(() => run('interval'), PENDING_RECONCILIATION_INTERVAL_MS);
  pendingReconciliationTimer.unref?.();
}

function sortedMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).slice().sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
}

export async function probeDispatchWhatsappClientHealth(options = {}) {
  const activeClient = options.activeClient || client;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 10000));
  lastHealthCheckAt = new Date().toISOString();
  if (!activeClient || (!options.activeClient && !ready)) {
    lastHealthState = 'NOT_READY';
    lastHealthError = null;
    return { healthy: false, state: lastHealthState, error: null };
  }
  if (activeClient.pupPage?.isClosed?.()) {
    lastHealthState = 'PAGE_CLOSED';
    lastHealthError = 'La página de Chromium está cerrada.';
    return { healthy: false, state: lastHealthState, error: lastHealthError };
  }
  if (typeof activeClient.getState !== 'function') {
    lastHealthState = 'STATE_UNAVAILABLE';
    lastHealthError = 'El cliente no expone getState().';
    return { healthy: false, state: lastHealthState, error: lastHealthError };
  }
  let timeoutId = null;
  try {
    const state = await Promise.race([
      activeClient.getState(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('La consulta de estado superó el tiempo máximo.')), timeoutMs);
        timeoutId.unref?.();
      })
    ]);
    lastHealthState = String(state || 'UNKNOWN');
    lastHealthError = null;
    return { healthy: lastHealthState === CONNECTED_CLIENT_STATE, state: lastHealthState, error: null };
  } catch (error) {
    lastHealthState = 'ERROR';
    lastHealthError = error?.message || 'No fue posible comprobar el estado del cliente.';
    return { healthy: false, state: lastHealthState, error: lastHealthError };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function initDispatchWhatsappClient() {
  if (client || initializing) return client;
  manualLogoutRequested = false;
  const dataPath = ensureAuthDataPath();
  cleanupChromiumProfileLocks(dataPath);
  clearReconnectTimer();
  initializing = true;
  loadWhatsappWebModule()
    .then(({ Client: WhatsappClient, LocalAuth: WhatsappLocalAuth }) => {
      if (client) return client;
      client = new WhatsappClient({
        authStrategy: new WhatsappLocalAuth({ clientId: 'dispatch', dataPath }),
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        puppeteer: buildPuppeteerOptions()
      });
      client.on('qr', (qr) => { lastQr = qr; ready = false; lastError = null; console.log('QR de WhatsApp despacho pendiente. Escanéalo para vincular la sesión:'); printTerminalQr(qr); });
      client.on('authenticated', () => { lastAuthenticatedAt = new Date().toISOString(); lastError = null; console.log('WhatsApp de despacho autenticado.'); });
      client.on('ready', () => { ready = true; lastQr = null; lastError = null; lastReadyAt = new Date().toISOString(); console.log('WhatsApp de despacho conectado.'); startPendingConfirmationReconciliation(client); });
      bindInboundMessageListeners(client);
      client.on('disconnected', (reason) => {
        ready = false;
        lastQr = null;
        lastError = reason ? `WhatsApp de despacho desconectado: ${reason}` : 'WhatsApp de despacho desconectado.';
        console.warn(lastError);
        resetClientReference()
          .catch((error) => console.warn('[dispatch-wa] No fue posible liberar el cliente desconectado.', error?.message || error))
          .finally(() => scheduleReconnect(reason || 'desconectado'));
      });
      client.on('auth_failure', (message) => {
        ready = false;
        lastQr = null;
        lastError = message ? `Fallo de autenticación de WhatsApp despacho: ${message}` : 'Fallo de autenticación de WhatsApp despacho.';
        console.warn(lastError);
        resetClientReference()
          .catch((error) => console.warn('[dispatch-wa] No fue posible liberar el cliente con fallo de autenticación.', error?.message || error))
          .finally(() => scheduleReconnect('fallo de autenticación'));
      });
      client.initialize()
        .catch(async (error) => {
          ready = false;
          lastQr = null;
          lastError = formatBrowserLaunchError(error);
          await resetClientReference();
          console.error('Error inicializando WhatsApp de despacho.', error);
          scheduleReconnect('error de inicio');
        })
        .finally(() => { initializing = false; });
      return client;
    })
    .catch((error) => { ready = false; lastQr = null; lastError = error?.message || 'No fue posible preparar WhatsApp de despacho.'; initializing = false; console.error('Error preparando WhatsApp de despacho.', error); });
  return client;
}

export function getDispatchWhatsappStatus() {
  return { ready, initializing, reconnecting: Boolean(reconnectTimer), manualLogoutRequested, lastQr, lastError, lastReadyAt, lastAuthenticatedAt, lastInboundAt, lastConfirmationAt, lastHealthCheckAt, lastHealthState, lastHealthError, pendingReconciliationRunning, lastPendingReconciliationAt, lastPendingReconciliationProcessed, ...authStorageInfo() };
}

export async function getDispatchWhatsappStatusView(options = {}) {
  const autoStart = Boolean(options?.autoStart);
  if (autoStart && !ready && !lastQr && !initializing && !client) initDispatchWhatsappClient();
  let qrImage = null;
  if (lastQr) {
    try { qrImage = await QRCode.toDataURL(lastQr); }
    catch (error) { console.error('No fue posible generar imagen QR de WhatsApp despacho.', error); }
  }
  return { ready, initializing, reconnecting: Boolean(reconnectTimer), manualLogoutRequested, lastQr, qrImage, lastError, lastReadyAt, lastAuthenticatedAt, lastInboundAt, lastConfirmationAt, lastHealthCheckAt, lastHealthState, lastHealthError, pendingReconciliationRunning, lastPendingReconciliationAt, lastPendingReconciliationProcessed, ...authStorageInfo() };
}

export async function closeDispatchWhatsappSession() {
  manualLogoutRequested = true;
  clearReconnectTimer();
  stopPendingConfirmationReconciliation();
  pendingConfirmationByPhone.clear();
  pendingConfirmationByChatId.clear();
  inboundLocks.clear();
  const oldClient = client;
  client = null;
  initializing = false;
  ready = false;
  lastQr = null;
  lastError = LOGGED_OUT_MESSAGE;
  if (oldClient) {
    try { await oldClient.logout(); }
    catch (error) { console.warn('No fue posible cerrar sesión limpiamente en WhatsApp despacho.', error); }
    try { await oldClient.destroy(); }
    catch (error) { console.warn('No fue posible destruir completamente el cliente de WhatsApp despacho.', error); }
  }
  return getDispatchWhatsappStatus();
}

export async function sendDispatchWhatsappMessage({ phone, message, context }) {
  const normalizedMessage = normalizeMessage(message);
  if (!normalizedMessage) throw buildError('El mensaje de WhatsApp no puede estar vacío.', 400);
  if (/<[^>]+>/.test(normalizedMessage)) throw buildError('El mensaje de WhatsApp no puede contener HTML.', 400);
  const activeClient = await getReadyClient();
  const recipient = await getRecipientId(activeClient, phone);
  const lockKey = reserveSendLock({ channelType: 'text', phone: recipient.normalizedPhone, payload: normalizedMessage });
  let pending = null;
  try {
    const chatAliases = await resolveDispatchWhatsappChatAliases(activeClient, {
      phone: recipient.normalizedPhone,
      chatIds: [recipient.serializedId]
    });
    pending = await preparePendingConfirmationLink({
      phone: recipient.normalizedPhone,
      context,
      chatId: recipient.serializedId,
      chatIds: chatAliases
    });
    const sent = await activeClient.sendMessage(recipient.serializedId, normalizedMessage);
    const providerMessageId = sent?.id?._serialized || sent?.id?.id || null;
    await finalizePendingConfirmationLink({
      pending,
      chatIds: chatIdsFromSentMessage(recipient, sent),
      providerMessageId
    });
    return { phone: recipient.normalizedPhone, providerMessageId };
  } catch (error) {
    await markPendingConfirmationDeliveryUnknown(pending);
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
    return { phone: recipient.normalizedPhone, providerMessageId: sent?.id?._serialized || sent?.id?.id || null };
  } catch (error) {
    releaseSendLock(lockKey);
    throw error;
  }
}
