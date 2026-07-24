from pathlib import Path


def replace_once(content, old, new, label):
    count = content.count(old)
    if count != 1:
        raise SystemExit(f'{label}: se esperaba 1 coincidencia y se encontraron {count}')
    return content.replace(old, new, 1)


def replace_between(content, start, end, replacement, label):
    start_index = content.find(start)
    if start_index < 0:
        raise SystemExit(f'{label}: no se encontró el marcador inicial')
    end_index = content.find(end, start_index + len(start))
    if end_index < 0:
        raise SystemExit(f'{label}: no se encontró el marcador final')
    return content[:start_index] + replacement + content[end_index:]


runtime_path = Path('src/services/dispatchWhatsappWebServiceV6.js')
facade_path = Path('src/services/dispatchWhatsappWebService.js')
route_path = Path('src/routes/dispatchWaRouterV2.js')
test_path = Path('test/dispatchWhatsappRuntimeContracts.test.js')

runtime = runtime_path.read_text(encoding='utf-8')
route = route_path.read_text(encoding='utf-8')
tests = test_path.read_text(encoding='utf-8')

if 'CATCHUP_ENABLED' not in runtime and 'recoverStalledInitialization' not in route:
    print('La limpieza #688 ya estaba aplicada.')
    raise SystemExit(0)

runtime = replace_once(
    runtime,
    """const RECONNECT_DELAY_MS = Number(process.env.DISPATCH_WWEB_RECONNECT_DELAY_MS || 5000);
const CONFIRMATION_MEMORY_TTL_MS = Number(process.env.DISPATCH_WA_CONFIRMATION_MEMORY_TTL_MS || 36 * 60 * 60 * 1000);
const INBOUND_LOCK_TTL_MS = 30000;
const AUTO_START_ENABLED = process.env.DISPATCH_WWEB_AUTO_START !== 'false' && process.env.NODE_ENV !== 'test';
const AUTO_START_DELAY_MS = Number(process.env.DISPATCH_WWEB_AUTO_START_DELAY_MS || 1500);
const CATCHUP_ENABLED = process.env.DISPATCH_WA_CATCHUP_ENABLED !== 'false';
const CATCHUP_DELAY_MS = Number(process.env.DISPATCH_WA_CATCHUP_DELAY_MS || 4000);
const CATCHUP_CHAT_LIMIT = Number(process.env.DISPATCH_WA_CATCHUP_CHAT_LIMIT || 80);
const CATCHUP_MESSAGES_PER_CHAT = Number(process.env.DISPATCH_WA_CATCHUP_MESSAGES_PER_CHAT || 8);
const CATCHUP_MIN_INTERVAL_MS = Number(process.env.DISPATCH_WA_CATCHUP_MIN_INTERVAL_MS || 60000);
const CLIENT_DESTROY_TIMEOUT_MS = Math.max(1000, Number(process.env.DISPATCH_WWEB_DESTROY_TIMEOUT_MS || 5000));""",
    """const RECONNECT_DELAY_MS = Number(process.env.DISPATCH_WWEB_RECONNECT_DELAY_MS || 5000);
const CONFIRMATION_MEMORY_TTL_MS = Number(process.env.DISPATCH_WA_CONFIRMATION_MEMORY_TTL_MS || 36 * 60 * 60 * 1000);
const INBOUND_LOCK_TTL_MS = 30000;
const CLIENT_DESTROY_TIMEOUT_MS = Math.max(1000, Number(process.env.DISPATCH_WWEB_DESTROY_TIMEOUT_MS || 5000));""",
    'configuración de autoarranque y catch-up'
)

runtime = replace_once(
    runtime,
    "const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];\n",
    "",
    'constante de estados sin consumidores'
)

runtime = replace_once(
    runtime,
    """let reconnectTimer = null;
let catchupRunning = false;
let lastCatchupAt = null;
let lastCatchupStartedAt = 0;
let lastCatchupProcessed = 0;
let pendingReconciliationTimer = null;""",
    """let reconnectTimer = null;
let pendingReconciliationTimer = null;""",
    'estado del catch-up general'
)

runtime = replace_once(
    runtime,
    "console.warn(`[dispatch-wa] Mensaje enviado sin contexto completo de confirmación. phone=${normalizedPhone || 'unknown'} assignment=${assignmentId || 'missing'} request=${serviceRequestId || 'missing'}`);",
    "console.warn(`[dispatch-wa] Mensaje enviado sin contexto completo de confirmación. phonePresent=${normalizedPhone ? 'yes' : 'no'} assignment=${assignmentId || 'missing'} request=${serviceRequestId || 'missing'}`);",
    'log de contexto sin teléfono'
)

runtime = replace_once(
    runtime,
    "console.log(`[dispatch-wa] Confirmación pendiente recordada. assignment=${value.assignmentId} phone=${normalizedPhone} chatIds=${normalizedChatIds.length}.`);",
    "console.log(`[dispatch-wa] Confirmación pendiente recordada. assignment=${value.assignmentId} phoneLinked=yes chatAliases=${normalizedChatIds.length}.`);",
    'log de confirmación sin teléfono'
)

runtime = replace_once(
    runtime,
    """function resetClientReference() {
  stopPendingConfirmationReconciliation();
  const oldClient = client;
  client = null;
  initializing = false;
  ready = false;
  lastQr = null;
  if (oldClient) oldClient.destroy().catch((error) => console.warn('No fue posible cerrar completamente el cliente anterior de WhatsApp despacho.', error));
}""",
    """async function resetClientReference() {
  stopPendingConfirmationReconciliation();
  const oldClient = client;
  client = null;
  initializing = false;
  ready = false;
  lastQr = null;
  await destroyClientWithoutLogout(oldClient);
}""",
    'reciclaje esperado del cliente'
)

runtime = replace_once(
    runtime,
    "console.warn(`[dispatch-wa] No fue posible reconciliar el chat ${chatId}.`, error?.message || error);",
    "console.warn(`[dispatch-wa] No fue posible reconciliar un chat pendiente. chatType=${chatId.split('@')[1] || 'unknown'}.`, error?.message || error);",
    'log de reconciliación sin chat id'
)

runtime = replace_between(
    runtime,
    "function chatTimestamp(chat = {}) {",
    "export async function probeDispatchWhatsappClientHealth(options = {}) {",
    """function sortedMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).slice().sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
}

""",
    'retiro del catch-up general'
)

runtime = replace_once(
    runtime,
    """      client.on('ready', () => { ready = true; lastQr = null; lastError = null; lastReadyAt = new Date().toISOString(); console.log('WhatsApp de despacho conectado.'); startPendingConfirmationReconciliation(client); scheduleRecentConfirmationCatchup(client, 'ready'); });""",
    """      client.on('ready', () => { ready = true; lastQr = null; lastError = null; lastReadyAt = new Date().toISOString(); console.log('WhatsApp de despacho conectado.'); startPendingConfirmationReconciliation(client); });""",
    'ready con una sola recuperación'
)

runtime = replace_once(
    runtime,
    """      client.on('disconnected', (reason) => { ready = false; lastQr = null; lastError = reason ? `WhatsApp de despacho desconectado: ${reason}` : 'WhatsApp de despacho desconectado.'; console.warn(lastError); resetClientReference(); scheduleReconnect(reason || 'desconectado'); });""",
    """      client.on('disconnected', (reason) => {
        ready = false;
        lastQr = null;
        lastError = reason ? `WhatsApp de despacho desconectado: ${reason}` : 'WhatsApp de despacho desconectado.';
        console.warn(lastError);
        resetClientReference()
          .catch((error) => console.warn('[dispatch-wa] No fue posible liberar el cliente desconectado.', error?.message || error))
          .finally(() => scheduleReconnect(reason || 'desconectado'));
      });""",
    'desconexión ordenada'
)

runtime = replace_once(
    runtime,
    """      client.on('auth_failure', (message) => { ready = false; lastQr = null; lastError = message ? `Fallo de autenticación de WhatsApp despacho: ${message}` : 'Fallo de autenticación de WhatsApp despacho.'; console.warn(lastError); resetClientReference(); scheduleReconnect('fallo de autenticación'); });""",
    """      client.on('auth_failure', (message) => {
        ready = false;
        lastQr = null;
        lastError = message ? `Fallo de autenticación de WhatsApp despacho: ${message}` : 'Fallo de autenticación de WhatsApp despacho.';
        console.warn(lastError);
        resetClientReference()
          .catch((error) => console.warn('[dispatch-wa] No fue posible liberar el cliente con fallo de autenticación.', error?.message || error))
          .finally(() => scheduleReconnect('fallo de autenticación'));
      });""",
    'fallo de autenticación ordenado'
)

runtime = replace_once(
    runtime,
    """      client.initialize().catch((error) => { ready = false; lastQr = null; lastError = formatBrowserLaunchError(error); resetClientReference(); console.error('Error inicializando WhatsApp de despacho.', error); scheduleReconnect('error de inicio'); }).finally(() => { initializing = false; });""",
    """      client.initialize()
        .catch(async (error) => {
          ready = false;
          lastQr = null;
          lastError = formatBrowserLaunchError(error);
          await resetClientReference();
          console.error('Error inicializando WhatsApp de despacho.', error);
          scheduleReconnect('error de inicio');
        })
        .finally(() => { initializing = false; });""",
    'fallo de inicialización ordenado'
)

runtime = replace_once(
    runtime,
    "return { ready, initializing, reconnecting: Boolean(reconnectTimer), manualLogoutRequested, lastQr, lastError, lastReadyAt, lastAuthenticatedAt, lastInboundAt, lastConfirmationAt, lastHealthCheckAt, lastHealthState, lastHealthError, catchupRunning, lastCatchupAt, lastCatchupStartedAt, lastCatchupProcessed, pendingReconciliationRunning, lastPendingReconciliationAt, lastPendingReconciliationProcessed, ...authStorageInfo() };",
    "return { ready, initializing, reconnecting: Boolean(reconnectTimer), manualLogoutRequested, lastQr, lastError, lastReadyAt, lastAuthenticatedAt, lastInboundAt, lastConfirmationAt, lastHealthCheckAt, lastHealthState, lastHealthError, pendingReconciliationRunning, lastPendingReconciliationAt, lastPendingReconciliationProcessed, ...authStorageInfo() };",
    'estado runtime sin catch-up'
)

runtime = replace_once(
    runtime,
    "  if (ready && client) scheduleRecentConfirmationCatchup(client, autoStart ? 'status_start' : 'status_view');\n",
    "",
    'estado visual sin recorrido de chats'
)

runtime = replace_once(
    runtime,
    "return { ready, initializing, reconnecting: Boolean(reconnectTimer), manualLogoutRequested, lastQr, qrImage, lastError, lastReadyAt, lastAuthenticatedAt, lastInboundAt, lastConfirmationAt, lastHealthCheckAt, lastHealthState, lastHealthError, catchupRunning, lastCatchupAt, lastCatchupStartedAt, lastCatchupProcessed, pendingReconciliationRunning, lastPendingReconciliationAt, lastPendingReconciliationProcessed, ...authStorageInfo() };",
    "return { ready, initializing, reconnecting: Boolean(reconnectTimer), manualLogoutRequested, lastQr, qrImage, lastError, lastReadyAt, lastAuthenticatedAt, lastInboundAt, lastConfirmationAt, lastHealthCheckAt, lastHealthState, lastHealthError, pendingReconciliationRunning, lastPendingReconciliationAt, lastPendingReconciliationProcessed, ...authStorageInfo() };",
    'estado visual sin métricas retiradas'
)

runtime = replace_once(
    runtime,
    """if (AUTO_START_ENABLED) {
  setTimeout(() => {
    try { initDispatchWhatsappClient(); }
    catch (error) { console.error('[dispatch-wa] No fue posible iniciar automáticamente WhatsApp despacho.', error); }
  }, AUTO_START_DELAY_MS);
}
""",
    "",
    'autoarranque duplicado del runtime'
)

route = replace_once(
    route,
    "import { closeDispatchWhatsappSession, getDispatchWhatsappStatusView, initDispatchWhatsappClient, restartDispatchWhatsappClient, sendDispatchWhatsappMessage } from '../services/dispatchWhatsappWebService.js';",
    "import { closeDispatchWhatsappSession, getDispatchWhatsappStatusView, initDispatchWhatsappClient, sendDispatchWhatsappMessage } from '../services/dispatchWhatsappWebService.js';",
    'import de reinicio del router'
)

route = replace_once(
    route,
    """const ASSIGNMENT_MESSAGE_TYPE = 'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST';
const STALLED_INITIALIZATION_TIMEOUT_MS = Number(process.env.DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS || 60000);

let initializingSeenAtMs = null;
let recoveryInProgress = false;""",
    """const ASSIGNMENT_MESSAGE_TYPE = 'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST';""",
    'estado duplicado de recuperación del router'
)

route = replace_between(
    route,
    "function clearInitializationWatch(status = {}) {",
    "async function getStatusForViewer(req, { autoStart = true } = {}) {",
    "",
    'recuperación duplicada del router'
)

route = replace_once(
    route,
    """async function getStatusForViewer(req, { autoStart = true } = {}) {
  let status = await getDispatchWhatsappStatusView({ autoStart });
  if (shouldRecoverStalledInitialization(status)) {
    recoverStalledInitialization();
    status = { ...status, initializing: false, reconnecting: true, lastError: null };
  } else {
    clearInitializationWatch(status);
  }
  return viewerStatus(req, status);
}""",
    """async function getStatusForViewer(req, { autoStart = true } = {}) {
  return viewerStatus(req, await getDispatchWhatsappStatusView({ autoStart }));
}""",
    'consulta de estado del router'
)

tests = replace_once(
    tests,
    """test('active WhatsApp engine supports reconnect and recent-message catchup', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  assert.match(source, /function scheduleReconnect\\(reason\\)/);
  assert.match(source, /async function processRecentInboundConfirmations/);
  assert.match(source, /scheduleRecentConfirmationCatchup\\(client, 'ready'\\)/);
  assert.match(source, /activeClient\\.on\\('message'/);
  assert.match(source, /activeClient\\.on\\('message_create'/);
});""",
    """test('active WhatsApp engine supports reconnect and targeted persistent reconciliation', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  assert.match(source, /function scheduleReconnect\\(reason\\)/);
  assert.match(source, /async function processPersistedPendingConfirmations/);
  assert.match(source, /startPendingConfirmationReconciliation\\(client\\)/);
  assert.match(source, /activeClient\\.on\\('message'/);
  assert.match(source, /activeClient\\.on\\('message_create'/);
  assert.doesNotMatch(source, /CATCHUP_|processRecentInboundConfirmations|scheduleRecentConfirmationCatchup|activeClient\\.getChats\\(\\)/);
});""",
    'contrato de recuperación dirigida'
)

tests = replace_once(
    tests,
    """test('panel stalled recovery uses non-destructive restart instead of manual logout', () => {
  const route = readSource('src/routes/dispatchWaRouterV2.js');
  const recovery = between(route, 'function recoverStalledInitialization()', 'async function getStatusForViewer');
  assert.match(route, /restartDispatchWhatsappClient/);
  assert.match(recovery, /restartDispatchWhatsappClient\\('estado atascado detectado desde el panel'\\)/);
  assert.doesNotMatch(recovery, /closeDispatchWhatsappSession\\(/);
});""",
    """test('status polling delegates stalled recovery to the server watchdog', () => {
  const route = readSource('src/routes/dispatchWaRouterV2.js');
  const statusReader = between(route, 'async function getStatusForViewer', 'export function dispatchWhatsappNotificationsRouter');
  assert.doesNotMatch(route, /restartDispatchWhatsappClient|recoverStalledInitialization|STALLED_INITIALIZATION_TIMEOUT_MS/);
  assert.match(statusReader, /getDispatchWhatsappStatusView\\(\\{ autoStart \\}\\)/);
  assert.doesNotMatch(statusReader, /setTimeout|Date\\.now|recoveryInProgress/);
});""",
    'contrato de polling sin recuperación'
)

new_tests = r"""

test('runtime has one auto-start owner and status polling does not scan chats', () => {
  const runtime = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const facade = readSource('src/services/dispatchWhatsappWebService.js');
  const statusView = between(
    runtime,
    'export async function getDispatchWhatsappStatusView',
    'export async function closeDispatchWhatsappSession'
  );
  assert.match(facade, /startDispatchWhatsappWatchdog\(\);/);
  assert.doesNotMatch(runtime, /AUTO_START_ENABLED|AUTO_START_DELAY_MS|if \(AUTO_START_ENABLED\)/);
  assert.doesNotMatch(statusView, /getChats|scheduleRecentConfirmationCatchup|processRecentInboundConfirmations/);
});

test('client recycling waits for Chromium destruction before reconnecting', () => {
  const runtime = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const reset = between(runtime, 'async function resetClientReference', 'async function destroyClientWithoutLogout');
  const initialization = between(runtime, 'export function initDispatchWhatsappClient', 'export function getDispatchWhatsappStatus');
  assert.match(reset, /await destroyClientWithoutLogout\(oldClient\)/);
  assert.match(initialization, /resetClientReference\(\)[\s\S]*\.finally\(\(\) => scheduleReconnect\(reason \|\| 'desconectado'\)\)/);
  assert.match(initialization, /await resetClientReference\(\)/);
});

test('dispatch WhatsApp runtime logs avoid full phone and chat identifiers', () => {
  const runtime = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  assert.doesNotMatch(runtime, /phone=\$\{normalizedPhone/);
  assert.doesNotMatch(runtime, /reconciliar el chat \$\{chatId\}/);
  assert.match(runtime, /phonePresent=/);
  assert.match(runtime, /chatType=/);
});
"""

anchor = "test('current confirmation variants remain accepted', () => {"
anchor_index = tests.find(anchor)
if anchor_index < 0:
    raise SystemExit('inserción de pruebas #688: no se encontró el ancla')
tests = tests[:anchor_index] + new_tests + '\n' + tests[anchor_index:]

for forbidden in [
    'CATCHUP_ENABLED',
    'processRecentInboundConfirmations',
    'scheduleRecentConfirmationCatchup',
    'recoverStalledInitialization',
    'ACTIVE_ASSIGNMENT_STATUSES'
]:
    if forbidden in runtime or forbidden in route:
        raise SystemExit(f'limpieza incompleta: permanece {forbidden}')

runtime_path.write_text(runtime, encoding='utf-8')
route_path.write_text(route, encoding='utf-8')
test_path.write_text(tests, encoding='utf-8')

if not facade_path.exists():
    raise SystemExit('No se encontró la fachada canónica de WhatsApp despacho.')

print('Limpieza #688 aplicada correctamente.')
