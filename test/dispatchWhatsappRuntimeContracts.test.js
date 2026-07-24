import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function readSource(path) {
  return fs.readFileSync(path, 'utf8');
}

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return content.slice(startIndex, endIndex);
}

const LEGACY_SERVICE_PATHS = [
  'src/services/dispatchWhatsappWebServiceV2.js',
  'src/services/dispatchWhatsappWebServiceV3.js',
  'src/services/dispatchWhatsappWebServiceV4.js',
  'src/services/dispatchWhatsappWebServiceV5.js',
  'src/services/dispatchWhatsappWebServiceStable.js'
];

test('dispatch WhatsApp exposes one canonical facade for text, media and runtime status', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  assert.match(source, /from '\.\/dispatchWhatsappWebServiceV6\.js'/);
  assert.match(source, /initDispatchWhatsappClient as initRuntimeClient/);
  assert.match(source, /sendDispatchWhatsappMessage as sendRuntimeTextMessage/);
  assert.match(source, /export function initDispatchWhatsappClient/);
  assert.match(source, /export async function sendDispatchWhatsappMessage/);
  assert.match(source, /export \{ sendDispatchWhatsappMediaMessage \}/);
});

test('dispatch WhatsApp watchdog is server-owned and does not depend on the status browser tab', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  const watchdog = between(
    source,
    "async function runDispatchWhatsappWatchdog(reason = 'interval')",
    'export function startDispatchWhatsappWatchdog()'
  );
  assert.match(source, /DISPATCH_WWEB_WATCHDOG_ENABLED/);
  assert.match(source, /setInterval\(\(\) => \{/);
  assert.match(source, /startDispatchWhatsappWatchdog\(\);/);
  assert.match(watchdog, /const status = getRuntimeStatus\(\)/);
  assert.match(watchdog, /status\.manualLogoutRequested/);
  assert.match(watchdog, /initDispatchWhatsappClient\(\);/);
  assert.doesNotMatch(watchdog, /getRuntimeStatusView/);
});

test('existing auto-start kill switch also disables the server watchdog', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  assert.match(source, /const AUTO_START_ENABLED = process\.env\.DISPATCH_WWEB_AUTO_START !== 'false'/);
  assert.match(source, /const WATCHDOG_ENABLED = AUTO_START_ENABLED/);
});

test('watchdog recovers a stalled Chromium initialization without logging out the WhatsApp account', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  const watchdog = between(
    source,
    "async function runDispatchWhatsappWatchdog(reason = 'interval')",
    'export function startDispatchWhatsappWatchdog()'
  );
  assert.match(source, /let initializingSeenAtMs = null/);
  assert.match(source, /DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS/);
  assert.match(source, /status\.initializing && !status\.ready && !status\.lastQr && !status\.lastError/);
  assert.match(watchdog, /await restartDispatchWhatsappClient\(`watchdog:\$\{reason\}`\)/);
  assert.doesNotMatch(source, /scheduleStalledRecoveryProbe/);
  assert.doesNotMatch(watchdog, /closeDispatchWhatsappSession|closeRuntimeSession/);
});

test('manual WhatsApp logout is respected by the server watchdog', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  const statusCheck = source.indexOf('if (status.manualLogoutRequested) {');
  const initialize = source.indexOf('initDispatchWhatsappClient();', statusCheck);
  assert.ok(statusCheck >= 0);
  assert.ok(initialize > statusCheck);
});

test('canonical facade restores Railway Nix Chromium discovery and safe stale-process cleanup', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  const cleanup = between(
    source,
    'function killStaleChromiumProcesses(dataPath)',
    'function findNixChromiumExecutable()'
  );
  assert.match(source, /import \{ execFileSync \} from 'node:child_process'/);
  assert.match(source, /function findNixChromiumExecutable\(\)/);
  assert.match(source, /find \/nix\/store -path/);
  assert.match(cleanup, /execFileSync\('pkill', \['-f', dataPath\]/);
  assert.match(cleanup, /Number\(error\?\.status\) === 1/);
  assert.match(cleanup, /error\?\.code === 'ENOENT'/);
  assert.doesNotMatch(cleanup, /execFileSync\('sh'/);
  assert.doesNotMatch(cleanup, /shellQuote/);
  assert.match(source, /prepareRuntimeEnvironment\(\{ cleanupStaleProcesses: true \}\)/);
});

test('assignment and programming routes share the canonical WhatsApp service', () => {
  const assignmentRouter = readSource('src/routes/dispatchWaRouterV2.js');
  const programmingRouter = readSource('src/routes/dispatchProgrammingNotifications.js');
  assert.match(assignmentRouter, /services\/dispatchWhatsappWebService\.js/);
  assert.match(programmingRouter, /services\/dispatchWhatsappWebService\.js/);
  assert.doesNotMatch(assignmentRouter, /dispatchWhatsappWebServiceV\d+\.js/);
  assert.doesNotMatch(programmingRouter, /dispatchWhatsappWebServiceV\d+\.js/);
});

test('historical dispatch WhatsApp service variants are removed', () => {
  for (const path of LEGACY_SERVICE_PATHS) {
    assert.equal(fs.existsSync(path), false, `${path} should not exist`);
  }
});

test('active WhatsApp engine keeps persistent Railway auth, LID mapping and restart-safe confirmation links', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const schema = readSource('prisma/schema.prisma');
  assert.match(source, /RAILWAY_VOLUME_MOUNT_PATH/);
  assert.match(source, /new WhatsappLocalAuth\(\{ clientId: 'dispatch', dataPath \}\)/);
  assert.match(source, /getContactLidAndPhone/);
  assert.match(source, /const pendingConfirmationByChatId = new Map\(\)/);
  assert.match(source, /prisma\.dispatchWhatsappConfirmation\.createMany/);
  assert.match(source, /async function findPersistedPendingAssignmentByLink/);
  assert.match(schema, /model DispatchWhatsappConfirmation/);
});

test('active WhatsApp engine supports reconnect and targeted persistent reconciliation', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  assert.match(source, /function scheduleReconnect\(reason\)/);
  assert.match(source, /async function processPersistedPendingConfirmations/);
  assert.match(source, /startPendingConfirmationReconciliation\(client\)/);
  assert.match(source, /activeClient\.on\('message'/);
  assert.match(source, /activeClient\.on\('message_create'/);
  assert.doesNotMatch(source, /CATCHUP_|processRecentInboundConfirmations|scheduleRecentConfirmationCatchup|activeClient\.getChats\(\)/);
});



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

test('current confirmation variants remain accepted', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  assert.match(source, /text === 'confirmado'/);
  assert.match(source, /text === 'si'/);
  assert.match(source, /text === 'ok'/);
  assert.match(source, /text === 'listo'/);
  assert.match(source, /text === 'recibido'/);
});

test('confirmation contexts from past service dates are excluded without changing assignment history', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  assert.match(source, /dispatchServiceDateKey, todayIsoDateCO/);
  assert.match(source, /async function validateOutgoingAssignmentContext/);
  assert.match(source, /serviceDate < today/);
  assert.match(source, /async function expirePastConfirmationLinks/);
  assert.match(source, /data: \{ status: 'EXPIRED' \}/);
  assert.doesNotMatch(source, /dispatchAssignment\.updateMany/);
  assert.match(source, /await validateOutgoingAssignmentContext\(args\.context, args\.phone\)/);
  assert.match(source, /expirePastConfirmationLinks\('startup'\)/);
});

test('canonical text sender preserves the existing AM and PM message formatting', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  assert.match(source, /function hourLabel\(value\)/);
  assert.match(source, /function labelHours\(value\)/);
  assert.match(source, /message: labelHours\(args\.message\)/);
});

test('service request summary does not render the all requests toolbar button', () => {
  const view = readSource('src/views/operacionesSolicitudesResumen.ejs');
  assert.doesNotMatch(view, /Ver todas las solicitudes/);
});

test('assignment board sends canonical context without a global fetch interception patch', () => {
  const view = readSource('src/views/operacionesAsignacionesConfirmacion.ejs');
  const route = readSource('src/routes/dispatchWaRouterV2.js');
  assert.match(view, /data-service-request-id="<%= selectedServiceRequest\.id %>"/);
  assert.match(view, /data-worker-id="<%= assignment\.worker\.id %>"/);
  assert.match(view, /JSON\.stringify\(\{phone,message,context\}\)/);
  assert.match(view, /messageType:'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST'/);
  assert.match(route, /!context\?\.assignmentId \|\| !context\?\.serviceRequestId \|\| !context\?\.workerId/);
  assert.doesNotMatch(view, /__dispatchWhatsappFetchPatched/);
});

test('server validates that assignment worker and recipient phone are the same', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  assert.match(source, /workerId,/);
  assert.match(source, /worker: \{ select: \{ phone: true \} \}/);
  assert.match(source, /recipientPhone !== assignmentPhone/);
  assert.match(source, /validateOutgoingAssignmentContext\(args\.context, args\.phone\)/);
});

test('confirmation context is persisted before WhatsApp send and uncertain delivery remains recoverable', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const sender = between(source, 'export async function sendDispatchWhatsappMessage', 'export async function sendDispatchWhatsappMediaMessage');
  assert.ok(sender.indexOf('preparePendingConfirmationLink') < sender.indexOf('activeClient.sendMessage'));
  assert.match(source, /tx\.dispatchWhatsappConfirmation\.create\(/);
  assert.match(source, /status: 'DELIVERY_UNKNOWN'/);
  assert.match(source, /RECOVERABLE_CONFIRMATION_LINK_STATUSES = \['PENDING', 'DELIVERY_UNKNOWN'\]/);
  assert.match(source, /Los alias persistidos antes del envío mantienen recuperable la confirmación/);
});

test('persistent reconciliation targets exact pending assignments and runs without dashboard polling', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  assert.match(source, /processPersistedPendingConfirmations/);
  assert.match(source, /prisma\.dispatchWhatsappConfirmation\.findMany/);
  assert.match(source, /activeClient\.getChatById/);
  assert.match(source, /fromMe: false/);
  assert.match(source, /setInterval\(\(\) => run\('interval'\), PENDING_RECONCILIATION_INTERVAL_MS\)/);
  assert.match(source, /startPendingConfirmationReconciliation\(client\)/);
});

test('confirmation text policy and pending target selection behave deterministically', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const runtime = await import('../src/services/dispatchWhatsappWebServiceV6.js?contract-test=557');
  assert.equal(runtime.isAutomaticConfirmationReply('Confirmado'), true);
  assert.equal(runtime.isAutomaticConfirmationReply('Sí, confirmado'), true);
  assert.equal(runtime.isAutomaticConfirmationReply('recibido'), true);
  assert.equal(runtime.isAutomaticConfirmationReply('No puedo asistir'), false);
  const selected = runtime.selectLatestPendingConfirmationTargets([
    { assignmentId: 'a1', id: 'old', createdAt: '2026-07-20T10:00:00Z' },
    { assignmentId: 'a2', id: 'only', createdAt: '2026-07-20T11:00:00Z' },
    { assignmentId: 'a1', id: 'new', createdAt: '2026-07-20T12:00:00Z' }
  ]);
  assert.deepEqual(selected.map((item) => item.id).sort(), ['new', 'only']);
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

test('runtime reports whether LocalAuth storage is persistent', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  assert.match(source, /authStoragePersistent/);
  assert.match(source, /authStorageMode: authStoragePersistent \? 'PERSISTENT' : 'EPHEMERAL'/);
  assert.match(source, /RAILWAY_VOLUME_MOUNT_PATH/);
  assert.match(source, /DISPATCH_WWEB_AUTH_PERSISTENT/);
});

test('automatic thanks are persisted before sending and orphaned confirmations are repaired', () => {
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

test('runtime identifies only an auth directory inside the Railway volume as persistent', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const runtime = await import('../src/services/dispatchWhatsappWebServiceV6.js?path-test=557');
  assert.equal(runtime.isPathWithinRoot('/data', '/data/dispatch-wweb-auth'), true);
  assert.equal(runtime.isPathWithinRoot('/data', '/tmp/dispatch-wweb-auth'), false);
  assert.equal(runtime.isPathWithinRoot('/data', '/data-other/auth'), false);
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

test('WhatsApp status view omits storage implementation details and surfaces polling failures', () => {
  const view = readSource('src/views/operacionesWhatsappEstado.ejs');
  assert.doesNotMatch(view, /storage-box|storageBox|storageLabel|storageText/);
  assert.doesNotMatch(view, /Sesión persistente|Sesión en almacenamiento efímero|LocalAuth|renderStorageStatus/);
  assert.match(view, /function renderStatusError\(\)/);
  assert.match(view, /catch \(error\)/);
  assert.match(view, /renderStatusError\(\)/);
  assert.match(view, /refreshStatus\(\);\s*window\.setInterval\(refreshStatus, 3000\)/);
});

test('stalled recovery releases the client without deleting LocalAuth session data', () => {
  const runtime = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  const restart = between(runtime, 'export async function restartDispatchWhatsappClient', 'async function getReadyClient');
  assert.match(restart, /client = null/);
  assert.match(restart, /initializing = false/);
  assert.match(restart, /destroyClientWithoutLogout\(oldClient\)/);
  assert.match(restart, /cleanupChromiumProfileLocks\(dataPath\)/);
  assert.match(restart, /initDispatchWhatsappClient\(\)/);
  assert.doesNotMatch(restart, /logout\(/);
});

test('status polling delegates stalled recovery to the server watchdog', () => {
  const route = readSource('src/routes/dispatchWaRouterV2.js');
  const statusReader = between(route, 'async function getStatusForViewer', 'export function dispatchWhatsappNotificationsRouter');
  assert.doesNotMatch(route, /restartDispatchWhatsappClient|recoverStalledInitialization|STALLED_INITIALIZATION_TIMEOUT_MS/);
  assert.match(statusReader, /getDispatchWhatsappStatusView\(\{ autoStart \}\)/);
  assert.doesNotMatch(statusReader, /setTimeout|Date\.now|recoveryInProgress/);
});

test('stale cleanup includes uncertain delivery and pending automatic replies', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  assert.match(source, /EXPIRABLE_CONFIRMATION_LINK_STATUSES = \['PENDING', 'DELIVERY_UNKNOWN', 'CONFIRMED_REPLY_PENDING'\]/);
  assert.match(source, /status: \{ in: EXPIRABLE_CONFIRMATION_LINK_STATUSES \}/);
});



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
