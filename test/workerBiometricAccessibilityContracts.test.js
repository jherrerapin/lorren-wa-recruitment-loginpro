import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el portal carga un único controlador biométrico después del motor y del endurecimiento', async () => {
  const loader = await read('src/public/worker-biometric.js');
  const corePosition = loader.indexOf('/public/worker-biometric-core.js');
  const mobilePosition = loader.indexOf('/public/worker-biometric-mobile.js');
  const hardeningPosition = loader.indexOf('/public/worker-portal-hardening.js');
  const flowPosition = loader.indexOf('/public/worker-portal-biometric-flow.js');

  assert.ok(corePosition >= 0);
  assert.ok(mobilePosition > corePosition);
  assert.ok(hardeningPosition > mobilePosition);
  assert.ok(flowPosition > hardeningPosition);
  assert.match(loader, /BIOMETRIC_ASSET_VERSION\s*=\s*'20260730-single-controller-v1'/);
  assert.doesNotMatch(loader, /worker-biometric-accessibility\.js/);
  assert.match(loader, /\/operaciones\/portal\/offline\.js/);
});

test('la autorización aparece antes del estado, la cámara y la ubicación', async () => {
  const view = await read('src/views/workerPortal.ejs');
  const consentPosition = view.indexOf('id="photo-consent-wrap"');
  const statusPosition = view.indexOf('id="mark-result"');
  const cameraPosition = view.indexOf('id="camera-step"');
  const locationPosition = view.indexOf('id="location-step"');

  assert.ok(consentPosition >= 0);
  assert.ok(statusPosition > consentPosition);
  assert.ok(cameraPosition > statusPosition);
  assert.ok(locationPosition > cameraPosition);
  assert.doesNotMatch(view, /id="capture-photo"/);
  assert.doesNotMatch(view, /id="retry-photo"/);
  assert.match(view, /id="retry-biometric" hidden>Intentar nuevamente/);
  assert.match(view, /aria-live="assertive"/);
});

test('la ventana móvil mantiene autorización, estado, cámara y acciones sin desplazamiento', async () => {
  const view = await read('src/views/workerPortal.ejs');

  assert.match(view, /#mark-dialog[\s\S]*width:\s*100vw/);
  assert.match(view, /height:\s*100dvh/);
  assert.match(view, /#mark-dialog \.dialog-body[\s\S]*grid-template-rows/);
  assert.match(view, /overflow:\s*hidden/);
  assert.match(view, /#photo-consent-wrap\s*\{\s*grid-row:\s*2/);
  assert.match(view, /#mark-result\s*\{\s*grid-row:\s*3/);
  assert.match(view, /#mark-dialog \.dialog-actions[\s\S]*grid-row:\s*6/);
  assert.match(view, /\.icon-button[\s\S]*width:\s*52px/);
  assert.match(view, /\.consent input[\s\S]*width:\s*32px/);
  assert.match(view, /#submit-mark\s*\{\s*min-height:\s*60px/);
});

test('marcar la autorización inicia el flujo y los reintentos son automáticos', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');

  assert.match(flow, /photoConsent\?\.addEventListener\('change'/);
  assert.match(flow, /runAutomaticVerification\(\)/);
  assert.match(flow, /const MAX_AUTOMATIC_ATTEMPTS = 2/);
  assert.match(flow, /for \(let attempt = 1; attempt <= MAX_AUTOMATIC_ATTEMPTS; attempt \+= 1\)/);
  assert.match(flow, /state\.idempotencyKey = newIdempotencyKey\(\)/);
  assert.match(flow, /portalBiometricRequest\('desafio'/);
  assert.match(flow, /portalBiometricRequest\('verificar'/);
  assert.doesNotMatch(flow, /activeMarkButton\.click\(\)/);
  assert.doesNotMatch(flow, /MutationObserver/);
  assert.doesNotMatch(flow, /capturePhotoButton/);
});

test('la marcación final continúa exigiendo GPS, autorización e identidad verificada', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');
  const mobile = await read('src/public/worker-biometric-mobile.js');

  assert.match(flow, /!state\.locationEvidence/);
  assert.match(flow, /!state\.biometricVerified/);
  assert.match(flow, /!state\.photoBlob/);
  assert.match(flow, /!photoConsent\?\.checked/);
  assert.match(flow, /verification\.verified !== true/);
  assert.match(flow, /captureMode', 'ONLINE_WEB'/);
  assert.match(mobile, /faces\.length !== 1/);
  assert.match(mobile, /challengeCompleted:\s*true/);
  assert.match(mobile, /MIN_REAL_SCORE = 0\.55/);
});
