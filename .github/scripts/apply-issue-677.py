from pathlib import Path
import re


def replace_once(text, old, new, label):
    if text.count(old) != 1:
        raise SystemExit(f'{label}: se esperaba 1 coincidencia y se encontraron {text.count(old)}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f'{label}: no se encontró el inicio')
    end_index = text.find(end, start_index + len(start))
    if end_index < 0:
        raise SystemExit(f'{label}: no se encontró el final')
    return text[:start_index] + replacement + text[end_index:]


v6_path = Path('src/services/dispatchWhatsappWebServiceV6.js')
v6 = v6_path.read_text(encoding='utf-8')

v6 = replace_once(
    v6,
    "const PENDING_RECONCILIATION_INTERVAL_MS = Math.max(15000, Number(process.env.DISPATCH_WA_RECONCILE_INTERVAL_MS || 60000));",
    "const PENDING_RECONCILIATION_INTERVAL_MS = Math.max(15000, Number(process.env.DISPATCH_WA_RECONCILE_INTERVAL_MS || 30000));",
    'intervalo de reconciliación'
)
v6 = replace_once(
    v6,
    "const AUTOMATIC_CONFIRMATION_REPLY = 'Gracias.';",
    "const AUTOMATIC_CONFIRMATION_REPLY = 'Gracias.';\nconst CONNECTED_CLIENT_STATE = 'CONNECTED';",
    'estado conectado'
)
v6 = replace_once(
    v6,
    "let lastPendingReconciliationProcessed = 0;",
    """let lastPendingReconciliationProcessed = 0;
let lastInboundAt = null;
let lastConfirmationAt = null;
let lastHealthCheckAt = null;
let lastHealthState = null;
let lastHealthError = null;""",
    'estado de observabilidad'
)

alias_anchor = """function normalizeMessage(message) {
  return String(message || '').trim().slice(0, MAX_MESSAGE_LENGTH);
}
"""
alias_block = """export async function resolveDispatchWhatsappChatAliases(activeClient, { phone = '', chatIds = [] } = {}) {
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

""" + alias_anchor
v6 = replace_once(v6, alias_anchor, alias_block, 'alias PN/LID')

reserve_start = "function reserveInbound(message) {"
reserve_end = "function buildSendLockKey({ channelType, phone, payload }) {"
reserve_replacement = """function reserveInbound(message) {
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

"""
v6 = replace_between(v6, reserve_start, reserve_end, reserve_replacement, 'bloqueo entrante')

prepare_start = "async function preparePendingConfirmationLink({ phone, context = {}, chatId = '' }) {"
prepare_end = "async function finalizePendingConfirmationLink({ pending, chatIds = [], providerMessageId = null }) {"
prepare_replacement = """async function preparePendingConfirmationLink({ phone, context = {}, chatId = '', chatIds = [] }) {
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

"""
v6 = replace_between(v6, prepare_start, prepare_end, prepare_replacement, 'persistencia previa con alias')

finalize_start = "async function finalizePendingConfirmationLink({ pending, chatIds = [], providerMessageId = null }) {"
finalize_end = "async function markPendingConfirmationDeliveryUnknown(pending) {"
finalize_replacement = """async function finalizePendingConfirmationLink({ pending, chatIds = [], providerMessageId = null }) {
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

"""
v6 = replace_between(v6, finalize_start, finalize_end, finalize_replacement, 'finalización de alias')

v6 = replace_once(
    v6,
    "where: { status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES }, expiresAt: { gt: new Date() }, ...where },",
    "where: { status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES }, ...where },",
    'búsqueda persistida sin TTL fijo'
)

claim_anchor = "async function sendAutomaticConfirmationReply(activeClient, chatId) {"
claim_block = """export async function claimDispatchAssignmentConfirmation({ assignment, phone = '', chatId = '', prismaClient = prisma } = {}) {
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

""" + claim_anchor
v6 = replace_once(v6, claim_anchor, claim_block, 'reclamo durable de confirmación')

apply_start = "async function applyAssignmentConfirmation({ activeClient, assignment, phone = '', chatId = '', eventName = 'message' } = {}) {"
apply_end = "async function resolveAssignmentForInboundConfirmation({ phone = '', sender = '', message = {} } = {}) {"
apply_replacement = """async function applyAssignmentConfirmation({ activeClient, assignment, phone = '', chatId = '', eventName = 'message' } = {}) {
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

"""
v6 = replace_between(v6, apply_start, apply_end, apply_replacement, 'confirmación durable')

resolve_start = "async function resolveAssignmentForInboundConfirmation({ phone = '', sender = '', message = {} } = {}) {"
resolve_end = "async function confirmAssignmentFromInboundMessage(activeClient, message, eventName = 'message') {"
resolve_replacement = """async function resolveAssignmentForInboundConfirmation({ phone = '', senders = [], message = {} } = {}) {
  const normalizedSenders = [...new Set(senders.map(normalizeChatId).filter(Boolean))];
  for (const sender of normalizedSenders) {
    const assignment = await findPendingAssignmentFromChatId(sender, message)
      || await findPersistedPendingAssignmentByLink({ phone, chatId: sender, message });
    if (assignment) return assignment;
  }
  return phone ? await findPendingAssignmentFromMemory(phone, message) : null;
}

"""
v6 = replace_between(v6, resolve_start, resolve_end, resolve_replacement, 'resolución multialias')

confirm_start = "async function confirmAssignmentFromInboundMessage(activeClient, message, eventName = 'message') {"
confirm_end = "function bindInboundMessageListeners(activeClient) {"
confirm_replacement = """async function confirmAssignmentFromInboundMessage(activeClient, message, eventName = 'message') {
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

"""
v6 = replace_between(v6, confirm_start, confirm_end, confirm_replacement, 'procesamiento entrante sin bloqueo anticipado')

reconciliation_start = "async function reconciliationChatIds(activeClient, link = {}) {"
reconciliation_end = "async function processPersistedConfirmationTarget(activeClient, link) {"
reconciliation_replacement = """async function reconciliationChatIds(activeClient, link = {}) {
  return resolveDispatchWhatsappChatAliases(activeClient, {
    phone: link.phone,
    chatIds: [link.chatId]
  });
}

"""
v6 = replace_between(v6, reconciliation_start, reconciliation_end, reconciliation_replacement, 'alias durante reconciliación')

repair_anchor = "async function retryPendingAutomaticReplies(activeClient) {"
repair_block = """async function repairConfirmedAssignmentsAwaitingReply() {
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

""" + repair_anchor
v6 = replace_once(v6, repair_anchor, repair_block, 'reparación de respuestas huérfanas')

v6 = replace_once(
    v6,
    "where: { status: CONFIRMED_REPLY_PENDING_STATUS, expiresAt: { gt: new Date() } },",
    "where: { status: CONFIRMED_REPLY_PENDING_STATUS },",
    'reintento de gracias sin TTL fijo'
)
v6 = replace_once(
    v6,
    "where: { status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES }, expiresAt: { gt: new Date() } },",
    "where: { status: { in: RECOVERABLE_CONFIRMATION_LINK_STATUSES } },",
    'reconciliación sin TTL fijo'
)
v6 = replace_once(
    v6,
    """    const targets = selectLatestPendingConfirmationTargets(links);
    for (const target of targets) processed += await processPersistedConfirmationTarget(activeClient, target);
    repliesRetried = await retryPendingAutomaticReplies(activeClient);""",
    """    const targets = selectLatestPendingConfirmationTargets(links);
    for (const target of targets) processed += await processPersistedConfirmationTarget(activeClient, target);
    const orphanedRepliesRepaired = await repairConfirmedAssignmentsAwaitingReply();
    repliesRetried = await retryPendingAutomaticReplies(activeClient);
    if (orphanedRepliesRepaired) console.log(`[dispatch-wa] Respuestas automáticas huérfanas reparadas=${orphanedRepliesRepaired}.`);""",
    'reparación dentro de reconciliación'
)

health_anchor = "export function initDispatchWhatsappClient() {"
health_block = """export async function probeDispatchWhatsappClientHealth(options = {}) {
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

""" + health_anchor
v6 = replace_once(v6, health_anchor, health_block, 'sonda de salud')

status_old = "return { ready, initializing, reconnecting: Boolean(reconnectTimer), manualLogoutRequested, lastQr, lastError, lastReadyAt, lastAuthenticatedAt, catchupRunning, lastCatchupAt, lastCatchupStartedAt, lastCatchupProcessed, pendingReconciliationRunning, lastPendingReconciliationAt, lastPendingReconciliationProcessed, ...authStorageInfo() };"
status_new = "return { ready, initializing, reconnecting: Boolean(reconnectTimer), manualLogoutRequested, lastQr, lastError, lastReadyAt, lastAuthenticatedAt, lastInboundAt, lastConfirmationAt, lastHealthCheckAt, lastHealthState, lastHealthError, catchupRunning, lastCatchupAt, lastCatchupStartedAt, lastCatchupProcessed, pendingReconciliationRunning, lastPendingReconciliationAt, lastPendingReconciliationProcessed, ...authStorageInfo() };"
if v6.count(status_old) != 2:
    raise SystemExit(f'estado runtime: se esperaban 2 coincidencias y se encontraron {v6.count(status_old)}')
v6 = v6.replace(status_old, status_new)

send_old = """    pending = await preparePendingConfirmationLink({
      phone: recipient.normalizedPhone,
      context,
      chatId: recipient.serializedId
    });"""
send_new = """    const chatAliases = await resolveDispatchWhatsappChatAliases(activeClient, {
      phone: recipient.normalizedPhone,
      chatIds: [recipient.serializedId]
    });
    pending = await preparePendingConfirmationLink({
      phone: recipient.normalizedPhone,
      context,
      chatId: recipient.serializedId,
      chatIds: chatAliases
    });"""
v6 = replace_once(v6, send_old, send_new, 'alias antes del envío')
v6_path.write_text(v6, encoding='utf-8')


facade_path = Path('src/services/dispatchWhatsappWebService.js')
facade = facade_path.read_text(encoding='utf-8')
facade = replace_once(
    facade,
    """  initDispatchWhatsappClient as initRuntimeClient,
  restartDispatchWhatsappClient as restartRuntimeClient,""",
    """  initDispatchWhatsappClient as initRuntimeClient,
  probeDispatchWhatsappClientHealth as probeRuntimeHealth,
  restartDispatchWhatsappClient as restartRuntimeClient,""",
    'import de sonda'
)
facade = replace_once(
    facade,
    "const STALLED_INITIALIZATION_TIMEOUT_MS = Math.max(60000, Number(process.env.DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS || 60000));",
    """const STALLED_INITIALIZATION_TIMEOUT_MS = Math.max(60000, Number(process.env.DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS || 60000));
const HEALTH_PROBE_TIMEOUT_MS = Math.max(3000, Number(process.env.DISPATCH_WWEB_HEALTH_TIMEOUT_MS || 10000));
const HEALTH_FAILURE_THRESHOLD = Math.max(1, Number(process.env.DISPATCH_WWEB_HEALTH_FAILURE_THRESHOLD || 2));""",
    'configuración de salud'
)
facade = replace_once(
    facade,
    "let runtimeEnvironmentPrepared = false;",
    """let runtimeEnvironmentPrepared = false;
let readyHealthFailures = 0;""",
    'contador de salud'
)
facade = replace_once(
    facade,
    """    if (status.manualLogoutRequested) {
      initializingSeenAtMs = null;
      return;
    }

    if (status.initializing && !status.ready && !status.lastQr && !status.lastError) {""",
    """    if (status.manualLogoutRequested) {
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
    if (status.initializing && !status.ready && !status.lastQr && !status.lastError) {""",
    'watchdog de salud'
)
facade = replace_once(
    facade,
    """export async function closeDispatchWhatsappSession() {
  stopDispatchWhatsappWatchdog();
  runtimeEnvironmentPrepared = false;""",
    """export async function closeDispatchWhatsappSession() {
  stopDispatchWhatsappWatchdog();
  runtimeEnvironmentPrepared = false;
  readyHealthFailures = 0;""",
    'reinicio de contador al cerrar'
)
facade_path.write_text(facade, encoding='utf-8')


test_path = Path('test/dispatchWhatsappRuntimeContracts.test.js')
test_source = test_path.read_text(encoding='utf-8')
old_test_start = "test('automatic thanks failures remain persisted and are retried without confirming twice', () => {"
old_test_end = "test('runtime identifies only an auth directory inside the Railway volume as persistent', async () => {"
new_test = """test('automatic thanks are persisted before sending and orphaned confirmations are repaired', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const applyBlock = between(
    source,
    'async function applyAssignmentConfirmation',
    'async function resolveAssignmentForInboundConfirmation'
  );
  assert.match(source, /CONFIRMED_REPLY_PENDING_STATUS = 'CONFIRMED_REPLY_PENDING'/);
  assert.match(source, /export async function claimDispatchAssignmentConfirmation/);
  assert.ok(applyBlock.indexOf('claimDispatchAssignmentConfirmation') < applyBlock.indexOf('sendAutomaticConfirmationReply'));
  assert.match(source, /async function repairConfirmedAssignmentsAwaitingReply/);
  assert.match(source, /assignment: \{ status: CONFIRMED_ASSIGNMENT_STATUS \}/);
  assert.match(source, /await repairConfirmedAssignmentsAwaitingReply\(\)/);
});

"""
test_source = replace_between(test_source, old_test_start, old_test_end, new_test, 'contrato anterior de gracias')

test_source += """

test('PN and LID aliases are resolved and persisted before the confirmation request is sent', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const runtime = await import('../src/services/dispatchWhatsappWebServiceV6.js?aliases-test=677');
  const aliases = await runtime.resolveDispatchWhatsappChatAliases({
    getNumberId: async () => ({ _serialized: '573001234567@c.us' }),
    getContactLidAndPhone: async () => [{ lid: '123456789@lid', pn: '573001234567@c.us' }]
  }, {
    phone: '3001234567',
    chatIds: ['573001234567@c.us']
  });
  assert.deepEqual(aliases.sort(), ['123456789@lid', '573001234567@c.us']);
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const sender = between(source, 'export async function sendDispatchWhatsappMessage', 'export async function sendDispatchWhatsappMediaMessage');
  assert.ok(sender.indexOf('resolveDispatchWhatsappChatAliases') < sender.indexOf('preparePendingConfirmationLink'));
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

test('an incomplete duplicate event cannot reserve the inbound lock before assignment resolution', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const inbound = between(
    source,
    'async function confirmAssignmentFromInboundMessage',
    'function bindInboundMessageListeners'
  );
  assert.ok(inbound.indexOf('resolveAssignmentForInboundConfirmation') < inbound.indexOf('reserveInbound(message)'));
  assert.match(inbound, /releaseInbound\(message\)/);
});

test('confirmation claim atomically leaves the automatic reply pending and repairs confirmed assignments', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const runtime = await import('../src/services/dispatchWhatsappWebServiceV6.js?claim-test=677');
  const operations = [];
  const tx = {
    dispatchAssignment: {
      updateMany: async () => { operations.push('assignment-confirmed'); return { count: 1 }; },
      findUnique: async () => ({ status: 'CONFIRMED' })
    },
    dispatchWhatsappConfirmation: {
      updateMany: async ({ data }) => { operations.push(`links-${data.status}`); return { count: 1 }; },
      create: async () => { operations.push('link-created'); return { id: 'link' }; }
    }
  };
  const prismaClient = { $transaction: async (callback) => callback(tx) };
  const result = await runtime.claimDispatchAssignmentConfirmation({
    assignment: { id: 'a1', serviceRequestId: 'r1' },
    phone: '3001234567',
    chatId: '573001234567@c.us',
    prismaClient
  });
  assert.deepEqual(result, { assignmentConfirmed: true, shouldReply: true, repaired: false });
  assert.deepEqual(operations, ['assignment-confirmed', 'links-CONFIRMED_REPLY_PENDING']);

  const repairTx = {
    dispatchAssignment: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ status: 'CONFIRMED' })
    },
    dispatchWhatsappConfirmation: {
      updateMany: async () => ({ count: 1 }),
      create: async () => ({ id: 'unused' })
    }
  };
  const repaired = await runtime.claimDispatchAssignmentConfirmation({
    assignment: { id: 'a2', serviceRequestId: 'r2' },
    prismaClient: { $transaction: async (callback) => callback(repairTx) }
  });
  assert.deepEqual(repaired, { assignmentConfirmed: false, shouldReply: true, repaired: true });
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

test('recoverable confirmations and pending automatic replies are not discarded by the legacy 36-hour TTL', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const latest = between(source, 'async function latestPendingConfirmationLink', 'async function findPersistedPendingAssignmentByLink');
  const retry = between(source, 'async function retryPendingAutomaticReplies', 'async function processPersistedPendingConfirmations');
  const reconcile = between(source, 'async function processPersistedPendingConfirmations', 'function stopPendingConfirmationReconciliation');
  assert.doesNotMatch(latest, /expiresAt:\s*\{\s*gt:/);
  assert.doesNotMatch(retry, /expiresAt:\s*\{\s*gt:/);
  assert.doesNotMatch(reconcile, /expiresAt:\s*\{\s*gt:/);
});

test('watchdog probes a ready client and restarts only after consecutive health failures', async () => {
  const runtimeSource = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const facade = readSource('src/services/dispatchWhatsappWebService.js');
  assert.match(runtimeSource, /export async function probeDispatchWhatsappClientHealth/);
  assert.match(runtimeSource, /activeClient\.getState\(\)/);
  assert.match(runtimeSource, /CONNECTED_CLIENT_STATE/);
  assert.match(facade, /probeDispatchWhatsappClientHealth as probeRuntimeHealth/);
  assert.match(facade, /HEALTH_FAILURE_THRESHOLD/);
  assert.match(facade, /readyHealthFailures \+= 1/);
  assert.match(facade, /restartDispatchWhatsappClient\(`health:/);

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const runtime = await import('../src/services/dispatchWhatsappWebServiceV6.js?health-test=677');
  assert.deepEqual(
    await runtime.probeDispatchWhatsappClientHealth({ activeClient: { getState: async () => 'CONNECTED' }, timeoutMs: 1000 }),
    { healthy: true, state: 'CONNECTED', error: null }
  );
  const unhealthy = await runtime.probeDispatchWhatsappClientHealth({ activeClient: { getState: async () => 'UNPAIRED' }, timeoutMs: 1000 });
  assert.equal(unhealthy.healthy, false);
  assert.equal(unhealthy.state, 'UNPAIRED');
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});
"""
test_path.write_text(test_source, encoding='utf-8')
