import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('el estado de WhatsApp refleja configuración Cloud sin loader, QR ni reinicios de Chromium', () => {
  const config = read('src/services/dispatchWhatsappCloudConfig.js');
  const view = read('src/views/operacionesWhatsappEstado.ejs');

  assert.match(config, /provider: 'META_CLOUD_API'/);
  assert.match(config, /configured: config\.configured/);
  assert.match(config, /missingConfiguration: config\.missing/);
  assert.match(view, /Configuración incompleta/);
  assert.match(view, /Variables pendientes/);
  assert.match(view, /WhatsApp Business Platform listo/);
  assert.doesNotMatch(view, /qrImage|waitingQr|Escanea|Chromium|cerrar-sesion/);
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
