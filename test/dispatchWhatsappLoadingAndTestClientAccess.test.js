import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('el estado de WhatsApp recupera una inicialización atascada y no mantiene el cargador cuando existe error', () => {
  const service = read('src/services/dispatchWhatsappWebService.js');
  const view = read('src/views/operacionesWhatsappEstado.ejs');

  assert.match(service, /STALLED_INITIALIZATION_ERROR/);
  assert.match(service, /async function recoverStalledInitialization/);
  assert.match(service, /await recoverStalledInitialization\(status, 'status-view'\)/);
  assert.match(service, /await restartDispatchWhatsappClient\(`stalled:\$\{reason\}`\)/);
  assert.match(service, /lastError: status\.lastError \|\| stalledInitializationError/);
  assert.match(view, /setHidden\(waitingQr, data\.ready \|\| Boolean\(data\.qrImage\) \|\| hasError\)/);
  assert.match(view, /setHidden\(unavailableBox, data\.ready \|\| Boolean\(data\.qrImage\) \|\| !hasError\)/);
});

test('solo dev puede ver y persistir la marca de cliente de prueba', () => {
  const view = read('src/views/operacionesClientes.ejs');
  const publicRoute = read('src/routes/publicDispatchClient.js');
  const coreRoute = read('src/routes/dispatchBridgeCore.js');

  const devGate = view.indexOf("<% if (role === 'dev') { %>");
  const testField = view.indexOf('name="isTestClient"');
  const gateClose = view.indexOf('<% } %>', testField);
  assert.ok(devGate >= 0 && testField > devGate && gateClose > testField);

  assert.match(publicRoute, /function isDev\(req\)/);
  assert.match(publicRoute, /buildClientData\(body, \{ canManageTestClient = false \} = \{\}\)/);
  assert.match(publicRoute, /\.\.\.\(canManageTestClient \? \{ isTestClient:/);
  assert.equal((publicRoute.match(/canManageTestClient: isDev\(req\)/g) || []).length, 2);

  assert.match(coreRoute, /function isDev\(req\)/);
  assert.equal((coreRoute.match(/\.\.\.\(isDev\(req\) \? \{ isTestClient:/g) || []).length, 2);
  assert.doesNotMatch(coreRoute, /isActive: normalizeString\(req\.body\.isActive\) !== 'false', isTestClient:/);
});
