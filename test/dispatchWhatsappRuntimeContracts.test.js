import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function readSource(path) {
  return fs.readFileSync(path, 'utf8');
}

test('whatsapp despacho runtime has Railway-compatible Chromium discovery and persistent auth path', () => {
  const source = readSource('src/services/dispatchWhatsappWebService.js');
  assert.match(source, /RAILWAY_VOLUME_MOUNT_PATH/);
  assert.match(source, /existsSync\('\/data'\)/);
  assert.match(source, /findNixChromiumExecutable/);
  assert.match(source, /find \/nix\/store -path/);
  assert.match(source, /DISPATCH_BROWSER_EXECUTABLE_PATH/);
});

test('dispatch WhatsApp V4 remembers confirmations by chat id for LID replies', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV4.js');
  assert.match(source, /const pendingConfirmationByChatId = new Map\(\)/);
  assert.match(source, /function normalizeChatId\(value\)/);
  assert.match(source, /function chatIdsFromSentMessage\(recipient, sent\)/);
  assert.match(source, /pendingConfirmationByChatId\.set\(chatId, value\)/);
  assert.match(source, /async function findPendingAssignmentFromChatId\(chatId\)/);
  assert.match(source, /await findPendingAssignmentFromChatId\(sender\)[\s\S]*findPendingAssignmentFromMemory\(phone\)/);
  assert.match(source, /pendingConfirmationByChatId\.delete\(normalizeChatId\(chatId\)\)/);
  assert.match(source, /pendingConfirmationByChatId\.clear\(\)/);
  assert.match(source, /getContactLidAndPhone/);
});


test('dispatch WhatsApp V4 persists confirmation links for restart-safe LID replies', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV4.js');
  const schema = readSource('prisma/schema.prisma');
  assert.match(schema, /model DispatchWhatsappConfirmation/);
  assert.match(source, /async function persistPendingConfirmationLink/);
  assert.match(source, /prisma\.dispatchWhatsappConfirmation\.createMany/);
  assert.match(source, /async function findPersistedPendingAssignmentByLink/);
  assert.match(source, /await findPersistedPendingAssignmentByLink\(\{ phone, chatId: sender \}\)/);
  assert.match(source, /async function markPersistedConfirmationLinksCompleted/);
  assert.doesNotMatch(source, /findLatestPendingAssignmentByContactName/);
});

test('dispatch WhatsApp V4 recovers missed Gracias replies from recent assignment chat history', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV4.js');
  assert.match(source, /function isDispatchAssignmentNotice/);
  assert.match(source, /const asksForConfirmation = \/\\b\(\?:confirma\|confirmar\|confirmacion\|confirmado\|recibido\)\\b\//);
  assert.match(source, /const looksLikeAssignment = \/\\b\(\?:asignacion\|programacion\|servicio\|cliente\|operacion\|direccion\|llegar\|hora\|horario\|fecha\|manana\)\\b\//);
  assert.match(source, /function parseDispatchAssignmentNotice/);
  assert.match(source, /async function recoverMissedAssignmentConfirmationFromChat/);
  assert.match(source, /isAutomaticConfirmationAck/);
  assert.match(source, /eventName: 'catchup_history'/);
  assert.match(source, /await findPendingAssignmentFromAssignmentNotice\(\{ notice, phone \}\)/);
});

test('dispatch WhatsApp V4 catchup keeps full chat ids when scanning recent LID chats', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV4.js');
  assert.match(source, /function chatIdFromChat\(chat = \{\}\)/);
  assert.match(source, /chat\.id\?\.server && chat\.id\?\.user \? `\$\{chat\.id\.user\}@\$\{chat\.id\.server\}`/);
  assert.match(source, /const serialized = chatIdFromChat\(chat\)/);
  assert.match(source, /const chatId = chatIdFromChat\(chat\)/);
});

test('dispatch WhatsApp V4 actively rescans existing confirmations after send and status checks', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV4.js');
  assert.match(source, /const CATCHUP_MIN_INTERVAL_MS = Number\(process\.env\.DISPATCH_WA_CATCHUP_MIN_INTERVAL_MS \|\| 60000\)/);
  assert.match(source, /function scheduleRecentConfirmationCatchup\(activeClient, reason = 'ready', options = \{\}\)/);
  assert.match(source, /processRecentInboundConfirmations\(activeClient, reason, options\)/);
  assert.match(source, /if \(ready && client\) scheduleRecentConfirmationCatchup\(client, autoStart \? 'status_start' : 'status_view'\)/);
  assert.match(source, /scheduleRecentConfirmationCatchup\(activeClient, 'after_assignment_send', \{ force: true \}\)/);
});

test('service request summary does not render the all requests toolbar button', () => {
  const view = readSource('src/views/operacionesSolicitudesResumen.ejs');
  assert.doesNotMatch(view, /Ver todas las solicitudes/);
});

test('dispatch WhatsApp router uses latest runtime with persistent confirmations and reconnect support', () => {
  const source = readSource('src/routes/dispatchWaRouterV2.js');
  assert.match(source, /dispatchWhatsappWebServiceV5\.js/);
  assert.doesNotMatch(source, /dispatchWhatsappWebServiceV3\.js/);
});
