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
  assert.match(source, /let initializingSeenAtMs = null/);
  assert.match(source, /DISPATCH_WWEB_STALLED_INIT_TIMEOUT_MS/);
  assert.match(source, /status\.initializing && !status\.ready && !status\.lastQr && !status\.lastError/);
  assert.match(source, /killStaleChromiumProcesses\(status\.authDataPath \|\| resolveAuthDataPath\(\)\)/);
  assert.match(source, /scheduleStalledRecoveryProbe\(\)/);
  assert.doesNotMatch(source, /closeRuntimeSession\(\)\.catch/);
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

test('active WhatsApp engine supports reconnect and recent-message catchup', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  assert.match(source, /function scheduleReconnect\(reason\)/);
  assert.match(source, /async function processRecentInboundConfirmations/);
  assert.match(source, /scheduleRecentConfirmationCatchup\(client, 'ready'\)/);
  assert.match(source, /activeClient\.on\('message'/);
  assert.match(source, /activeClient\.on\('message_create'/);
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
  assert.match(source, /prisma\.dispatchWhatsappConfirmation\.create\(/);
  assert.match(source, /status: 'DELIVERY_UNKNOWN'/);
  assert.match(source, /RECOVERABLE_CONFIRMATION_LINK_STATUSES = \['PENDING', 'DELIVERY_UNKNOWN'\]/);
  assert.match(source, /The primary row was created before sending/);
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

test('automatic thanks failures remain persisted and are retried without confirming twice', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV6.js');
  assert.match(source, /CONFIRMED_REPLY_PENDING_STATUS = 'CONFIRMED_REPLY_PENDING'/);
  assert.match(source, /automaticReplySent \? 'CONFIRMED' : CONFIRMED_REPLY_PENDING_STATUS/);
  assert.match(source, /async function retryPendingAutomaticReplies/);
  assert.match(source, /await retryPendingAutomaticReplies\(activeClient\)/);
  assert.match(source, /where: \{\s*assignmentId,\s*status: \{ in: \[\.\.\.RECOVERABLE_CONFIRMATION_LINK_STATUSES, CONFIRMED_REPLY_PENDING_STATUS\] \}/s);
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

test('WhatsApp status screen visibly reports persistent or ephemeral LocalAuth storage', () => {
  const view = readSource('src/views/operacionesWhatsappEstado.ejs');
  assert.match(view, /id="storageBox"/);
  assert.match(view, /Sesión persistente/);
  assert.match(view, /Sesión en almacenamiento efímero/);
  assert.match(view, /renderStorageStatus\(data\)/);
});

test('stale cleanup includes uncertain delivery and pending automatic replies', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  assert.match(source, /EXPIRABLE_CONFIRMATION_LINK_STATUSES = \['PENDING', 'DELIVERY_UNKNOWN', 'CONFIRMED_REPLY_PENDING'\]/);
  assert.match(source, /status: \{ in: EXPIRABLE_CONFIRMATION_LINK_STATUSES \}/);
});

