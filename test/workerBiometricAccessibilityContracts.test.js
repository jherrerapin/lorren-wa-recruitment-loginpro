import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el portal carga un único controlador biométrico después del motor y de la recuperación de cámara', async () => {
  const loader = await read('src/public/worker-biometric.js');
  const corePosition = loader.indexOf('/public/worker-biometric-core.js');
  const mobilePosition = loader.indexOf('/public/worker-biometric-mobile.js');
  const recoveryPosition = loader.indexOf('/public/worker-biometric-camera-recovery.js');
  const hardeningPosition = loader.indexOf('/public/worker-portal-hardening.js');
  const flowPosition = loader.indexOf('/public/worker-portal-biometric-flow.js');

  assert.ok(corePosition >= 0);
  assert.ok(mobilePosition > corePosition);
  assert.ok(recoveryPosition > mobilePosition);
  assert.ok(hardeningPosition > recoveryPosition);
  assert.ok(flowPosition > hardeningPosition);
  assert.match(loader, /BIOMETRIC_ASSET_VERSION\s*=\s*'20260730-mobile-camera-v3'/);
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

test('llegada, almuerzo y salida usan el mismo flujo biométrico', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');

  assert.match(flow, /\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\.includes\(state\.markType\)/);
  assert.match(flow, /BREAK_START:\s*'inicio-almuerzo'/);
  assert.match(flow, /BREAK_END:\s*'fin-almuerzo'/);
  assert.match(flow, /markType:\s*state\.markType/);
  assert.match(flow, /form\.set\('selfie', state\.photoBlob/);
});

test('el encuadre móvil muestra el vídeo completo y una guía facial amplia', async () => {
  const recovery = await read('src/public/worker-biometric-camera-recovery.js');

  assert.match(recovery, /object-fit:\s*contain\s*!important/);
  assert.match(recovery, /width:\s*84%\s*!important/);
  assert.match(recovery, /height:\s*88%\s*!important/);
  assert.match(recovery, /border-radius:\s*24px\s*!important/);
  assert.match(recovery, /#camera-step \.face-stage[\s\S]*width:\s*100%\s*!important/);
});

test('cada apertura reinicia el vídeo y exige un fotograma renderizado', async () => {
  const recovery = await read('src/public/worker-biometric-camera-recovery.js');

  assert.match(recovery, /video\.pause\(\)/);
  assert.match(recovery, /video\.srcObject = null/);
  assert.match(recovery, /requestVideoFrameCallback/);
  assert.match(recovery, /getVideoPlaybackQuality/);
  assert.match(recovery, /track\.readyState !== 'live'/);
  assert.match(recovery, /for \(const constraints of attempts\)/);
  assert.match(recovery, /facingMode:\s*\{ ideal:\s*'user' \}/);
  assert.match(recovery, /\{ video: true, audio: false \}/);
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
