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

test('service request summary does not render the all requests toolbar button', () => {
  const view = readSource('src/views/operacionesSolicitudesResumen.ejs');
  assert.doesNotMatch(view, /Ver todas las solicitudes/);
});
