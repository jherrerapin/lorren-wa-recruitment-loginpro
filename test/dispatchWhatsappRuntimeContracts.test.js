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
  assert.match(source, /find \/nix\/store -path '\*\/bin\/chromium'/);
  assert.match(source, /DISPATCH_BROWSER_EXECUTABLE_PATH/);
});

test('dispatch WhatsApp V4 remembers confirmations by chat id for LID replies', () => {
  const source = readSource('src/services/dispatchWhatsappWebServiceV4.js');
  assert.match(source, /const pendingConfirmationByChatId = new Map\(\)/);
  assert.match(source, /function normalizeChatId\(value\)/);
  assert.match(source, /function chatIdsFromSentMessage\(recipient, sent\)/);
  assert.match(source, /pendingConfirmationByChatId\.set\(chatId, value\)/);
  assert.match(source, /async function findPendingAssignmentFromChatId\(chatId\)/);
  assert.match(source, /await findPendingAssignmentFromChatId\(sender\) \|\| await findPendingAssignmentFromMemory\(phone\)/);
  assert.match(source, /pendingConfirmationByChatId\.delete\(normalizeChatId\(sender\)\)/);
  assert.match(source, /pendingConfirmationByChatId\.clear\(\)/);
  assert.match(source, /getContactLidAndPhone/);
});

test('service request summary does not render the all requests toolbar button', () => {
  const view = readSource('src/views/operacionesSolicitudesResumen.ejs');
  assert.doesNotMatch(view, /Ver todas las solicitudes/);
});
