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
  assert.match(source, /await validateOutgoingAssignmentContext\(args\.context\)/);
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