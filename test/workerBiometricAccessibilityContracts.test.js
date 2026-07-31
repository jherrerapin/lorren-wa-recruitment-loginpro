import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el portal carga un único motor móvil y un único controlador biométrico', async () => {
  const loader = await read('src/public/worker-biometric.js');
  const corePosition = loader.indexOf('/public/worker-biometric-core.js');
  const mobilePosition = loader.indexOf('/public/worker-biometric-mobile.js');
  const flowPosition = loader.indexOf('/public/worker-portal-biometric-flow.js');

  assert.ok(corePosition >= 0);
  assert.ok(mobilePosition > corePosition);
  assert.ok(flowPosition > mobilePosition);
  assert.match(loader, /BIOMETRIC_ASSET_RELEASE\s*=\s*'20260731-lifecycle-recovery'/);
  assert.doesNotMatch(loader, /worker-portal-hardening\.js/);
  assert.doesNotMatch(loader, /worker-biometric-camera-recovery\.js/);
  assert.doesNotMatch(loader, /worker-biometric-accessibility\.js/);
  assert.match(loader, /\/operaciones\/portal\/offline\.js/);
  await assert.rejects(read('src/public/worker-portal-hardening.js'));
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

test('marcar la autorización inicia el flujo y el segundo intento reconstruye recursos', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');

  assert.match(flow, /photoConsent\?\.addEventListener\('change'/);
  assert.match(flow, /runAutomaticVerification\(\)/);
  assert.match(flow, /const MAX_AUTOMATIC_ATTEMPTS = 2/);
  assert.match(flow, /for \(let attempt = 1; attempt <= MAX_AUTOMATIC_ATTEMPTS; attempt \+= 1\)/);
  assert.match(flow, /await biometricApi\.recover\(\{ reason: code, rotateBackend: true \}\)/);
  assert.match(flow, /state\.idempotencyKey = newIdempotencyKey\(\)/);
  assert.match(flow, /portalBiometricRequest\('desafio'/);
  assert.match(flow, /portalBiometricRequest\('verificar'/);
  assert.doesNotMatch(flow, /activeMarkButton\.click\(\)/);
  assert.doesNotMatch(flow, /MutationObserver/);
  assert.doesNotMatch(flow, /capturePhotoButton/);
});

test('llegada, almuerzo y salida usan el mismo flujo y servicio biométrico', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');
  const service = await read('src/services/workerBiometricService.js');

  assert.match(flow, /\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\.includes\(state\.markType\)/);
  assert.match(flow, /BREAK_START:\s*'inicio-almuerzo'/);
  assert.match(flow, /BREAK_END:\s*'fin-almuerzo'/);
  assert.match(flow, /markType:\s*state\.markType/);
  assert.match(flow, /form\.set\('selfie', state\.photoBlob/);
  assert.match(service, /BIOMETRIC_MARK_TYPES = new Set\(\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\)/);
  assert.match(service, /issueWorkerBiometricChallenge[\s\S]*BIOMETRIC_MARK_TYPES\.has\(markType\)/);
  assert.match(service, /assessWorkerBiometric[\s\S]*BIOMETRIC_MARK_TYPES\.has\(markType\)/);
  assert.match(service, /const MATCH_THRESHOLD = 0\.85/);
});

test('el encuadre móvil muestra el vídeo completo y una guía facial amplia', async () => {
  const view = await read('src/views/workerPortal.ejs');

  assert.match(view, /object-fit:\s*contain/);
  assert.match(view, /\.face-frame[\s\S]*width:\s*84%/);
  assert.match(view, /\.face-frame[\s\S]*height:\s*88%/);
  assert.match(view, /\.face-frame[\s\S]*border-radius:\s*24px/);
  assert.match(view, /#camera-step \.face-stage\s*\{\s*width:\s*100%;\s*max-width:\s*none/);
  assert.match(view, /id="camera-video" playsinline autoplay muted/);
  assert.match(view, /worker-biometric\.js\?v=/);
});

test('cada apertura exige pista activa, no silenciada y fotogramas visibles', async () => {
  const mobile = await read('src/public/worker-biometric-mobile.js');

  assert.match(mobile, /video\.pause\(\)/);
  assert.match(mobile, /video\.srcObject = null/);
  assert.match(mobile, /requestVideoFrameCallback/);
  assert.match(mobile, /getVideoPlaybackQuality/);
  assert.match(mobile, /track\.readyState !== 'live'/);
  assert.match(mobile, /track\.enabled !== true/);
  assert.match(mobile, /track\.muted === true/);
  assert.match(mobile, /track\.addEventListener\('mute'/);
  assert.match(mobile, /track\.addEventListener\('unmute'/);
  assert.match(mobile, /hasVisiblePixels\(video\)/);
  assert.match(mobile, /for \(const constraints of attempts\)/);
  assert.match(mobile, /\{ video: true, audio: false \}/);
});

test('Human se invalida al suspender la página y puede cambiar de backend', async () => {
  const mobile = await read('src/public/worker-biometric-mobile.js');

  assert.match(mobile, /cacheSensitivity:\s*0/);
  assert.match(mobile, /deallocate:\s*true/);
  assert.match(mobile, /const BACKENDS = Object\.freeze\(\['webgl', 'wasm', 'cpu'\]\)/);
  assert.match(mobile, /function invalidateRuntime/);
  assert.match(mobile, /async function recover/);
  assert.match(mobile, /rotateBackend:\s*options\.rotateBackend === true/);
  assert.match(mobile, /document\.addEventListener\('visibilitychange'/);
  assert.match(mobile, /document\.addEventListener\('freeze'/);
  assert.match(mobile, /document\.addEventListener\('resume'/);
  assert.match(mobile, /window\.addEventListener\('pagehide'/);
  assert.match(mobile, /window\.addEventListener\('pageshow'/);
  assert.match(mobile, /document\.wasDiscarded/);
});

test('la verificación usa tiempos independientes por etapa', async () => {
  const mobile = await read('src/public/worker-biometric-mobile.js');

  assert.match(mobile, /const BASELINE_TIMEOUT_MS = 12_000/);
  assert.match(mobile, /const CHALLENGE_TIMEOUT_MS = 9_000/);
  assert.match(mobile, /const FINAL_TIMEOUT_MS = 12_000/);
  assert.match(mobile, /const baselineDeadline = Date\.now\(\) \+ /);
  assert.match(mobile, /const challengeDeadline = Date\.now\(\) \+ /);
  assert.match(mobile, /const finalDeadline = Date\.now\(\) \+ /);
  assert.match(mobile, /biometric_baseline_timeout/);
  assert.match(mobile, /biometric_challenge_timeout/);
  assert.match(mobile, /biometric_final_timeout/);
  assert.doesNotMatch(mobile, /const timeoutAt = Date\.now\(\) \+ \(options\.timeoutMs \|\| CAPTURE_TIMEOUT_MS\)/);
});

test('el controlador pausa y reanuda automáticamente una validación interrumpida', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');

  assert.match(flow, /function pauseOpenVerification/);
  assert.match(flow, /function resumeOpenVerification/);
  assert.match(flow, /resumeVerificationPending/);
  assert.match(flow, /scheduleResumeVerification\(\)/);
  assert.match(flow, /document\.addEventListener\('visibilitychange'/);
  assert.match(flow, /document\.addEventListener\('freeze'/);
  assert.match(flow, /document\.addEventListener\('resume'/);
  assert.match(flow, /window\.addEventListener\('pagehide'/);
  assert.match(flow, /window\.addEventListener\('pageshow'/);
  assert.match(flow, /Reiniciando reconocimiento facial/);
});

test('la tolerancia visual no relaja identidad, rostro real ni desafío', async () => {
  const mobile = await read('src/public/worker-biometric-mobile.js');

  assert.match(mobile, /faceRatio < 0\.13/);
  assert.match(mobile, /faceRatio > 0\.92/);
  assert.match(mobile, /horizontalOffset > 0\.3 \|\| verticalOffset > 0\.3/);
  assert.match(mobile, /MIN_REAL_SCORE = 0\.55/);
  assert.match(mobile, /MIN_LIVE_SCORE = 0\.55/);
  assert.match(mobile, /faces\.length !== 1/);
  assert.match(mobile, /challengeCompleted:\s*true/);
});

test('la marcación final continúa exigiendo GPS, autorización e identidad verificada', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');

  assert.match(flow, /!state\.locationEvidence/);
  assert.match(flow, /!state\.biometricVerified/);
  assert.match(flow, /!state\.photoBlob/);
  assert.match(flow, /!photoConsent\?\.checked/);
  assert.match(flow, /verification\.verified !== true/);
  assert.match(flow, /captureMode', 'ONLINE_WEB'/);
});
