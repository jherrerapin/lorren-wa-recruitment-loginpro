import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el portal carga un bootstrap mínimo, un único motor y el controlador vigente', async () => {
  const loader = await read('src/public/worker-biometric.js');
  const bootstrap = await read('src/public/worker-biometric-core.js');
  const mobile = await read('src/public/worker-biometric-mobile.js');
  const bootstrapPosition = loader.indexOf('/public/worker-biometric-core.js');
  const mobilePosition = loader.indexOf('/public/worker-biometric-mobile.js');
  const flowPosition = loader.indexOf('/public/worker-portal-biometric-flow.js');

  assert.ok(bootstrapPosition >= 0);
  assert.ok(mobilePosition > bootstrapPosition);
  assert.ok(flowPosition > mobilePosition);
  assert.match(loader, /BIOMETRIC_ASSET_RELEASE\s*=\s*'20260804-worker-portal-biometric-v8'/);
  assert.match(loader, /navigator\.serviceWorker\.getRegistration\('\/operaciones\/portal'\)/);
  assert.match(loader, /message\.cacheName/);
  assert.doesNotMatch(loader, /BIOMETRIC_SHELL_CACHE/);
  assert.doesNotMatch(loader, /worker-portal-hardening\.js/);
  assert.doesNotMatch(loader, /worker-biometric-camera-recovery\.js/);
  assert.doesNotMatch(loader, /worker-biometric-accessibility\.js/);
  assert.match(loader, /\/public\/worker-portal-offline\.js/);
  assert.doesNotMatch(bootstrap, /function humanConfig|captureEnrollment|captureVerification|getUserMedia|human\.detect/);
  assert.match(mobile, /function humanConfig/);
  assert.match(mobile, /captureEnrollment/);
  assert.match(mobile, /captureVerification/);
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
  assert.match(view, /id="biometric-instruction"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(view, /#biometric-instruction\s*\{\s*display:\s*none/);
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
  assert.match(flow, /const MAX_AUTOMATIC_ATTEMPTS = 1/);
  assert.match(flow, /for \(let attempt = 1; attempt <= MAX_AUTOMATIC_ATTEMPTS; attempt \+= 1\)/);
  assert.match(flow, /await biometricApi\.recover\(\{ reason: code, rotateBackend: true \}\)/);
  assert.match(flow, /state\.idempotencyKey = newIdempotencyKey\(\)/);
  assert.match(flow, /portalBiometricRequest\('desafio'/);
  assert.match(flow, /portalBiometricRequest\('verificar'/);
  assert.match(flow, /biometricValidUntil/);
  assert.doesNotMatch(flow, /activeMarkButton\.click\(\)/);
  assert.doesNotMatch(flow, /MutationObserver/);
});

test('llegada, almuerzo y salida usan la misma evidencia biométrica estricta', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');
  const service = await read('src/services/workerBiometricService.js');

  assert.match(flow, /\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\.includes\(state\.markType\)/);
  assert.match(flow, /BREAK_START:\s*'inicio-almuerzo'/);
  assert.match(flow, /BREAK_END:\s*'fin-almuerzo'/);
  assert.match(flow, /challengeEvidence:\s*capture\.challengeEvidence/);
  assert.match(flow, /sampleDescriptors:\s*capture\.sampleDescriptors/);
  assert.match(flow, /sampleRealScores:\s*capture\.sampleRealScores/);
  assert.match(flow, /sampleLiveScores:\s*capture\.sampleLiveScores/);
  assert.match(service, /BIOMETRIC_MARK_TYPES = new Set\(\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\)/);
  assert.match(service, /const MATCH_THRESHOLD = 0\.85/);
  assert.match(service, /const SAMPLE_CONSISTENCY_THRESHOLD = 0\.78/);
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
  assert.match(mobile, /hasVisiblePixels\(video\)/);
  assert.match(mobile, /for \(const constraints of attempts\)/);
  assert.match(mobile, /\{ video: true, audio: false \}/);
});

test('Human se invalida al suspender la página y puede cambiar de backend', async () => {
  const mobile = await read('src/public/worker-biometric-mobile.js');

  assert.match(mobile, /cacheSensitivity:\s*0/);
  assert.match(mobile, /deallocate:\s*true/);
  assert.match(mobile, /const BACKENDS = Object\.freeze\(IS_ANDROID \? \['cpu'\] : \['webgl', 'wasm', 'cpu'\]\)/);
  assert.match(mobile, /const RUNTIME_MAX_IDLE_MS = 12 \* 60 \* 60 \* 1000/);
  assert.match(mobile, /invalidateRuntime\('runtime-idle'\)/);
  assert.match(mobile, /function invalidateRuntime/);
  assert.match(mobile, /async function recover/);
  assert.match(mobile, /document\.addEventListener\('visibilitychange'/);
  assert.match(mobile, /window\.addEventListener\('pagehide'/);
  assert.match(mobile, /document\.wasDiscarded/);
});

test('la verificación usa una etapa frontal corta con dos muestras', async () => {
  const mobile = await read('src/public/worker-biometric-mobile.js');

  assert.match(mobile, /const BASELINE_TIMEOUT_MS = 14_000/);
  assert.match(mobile, /const VERIFICATION_STAGE_SAMPLES = 2/);
  const start = mobile.indexOf('async function captureVerification');
  const end = mobile.indexOf('function stopStream', start);
  const verification = mobile.slice(start, end);
  assert.match(verification, /biometric_baseline_timeout/);
  assert.match(verification, /MODEL_PASSIVE_LIVENESS_V2/);
  assert.doesNotMatch(verification, /captureActiveChallenge|biometric_final_timeout/);
});

test('cada muestra exige anti-spoof y liveness sin elevar puntuaciones', async () => {
  const mobile = await read('src/public/worker-biometric-mobile.js');

  assert.match(mobile, /scores\.realScore < MIN_REAL_SCORE/);
  assert.match(mobile, /scores\.liveScore < MIN_LIVE_SCORE/);
  assert.match(mobile, /realScore:\s*Math\.min/);
  assert.match(mobile, /liveScore:\s*Math\.min/);
  assert.doesNotMatch(mobile, /Math\.max\(modelLiveScore,\s*MIN_LIVE_SCORE\)/);
  assert.match(mobile, /MODEL_PASSIVE_LIVENESS_V2/);
});

test('el controlador pausa y reinicia cualquier verificación interrumpida', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');

  assert.match(flow, /function pauseOpenVerification/);
  assert.match(flow, /function resumeOpenVerification/);
  assert.match(flow, /resumeVerificationPending/);
  assert.match(flow, /scheduleResumeVerification\(\)/);
  assert.match(flow, /clearVerification\(\)/);
  assert.match(flow, /document\.addEventListener\('visibilitychange'/);
  assert.match(flow, /window\.addEventListener\('pageshow'/);
  assert.match(flow, /Reiniciando reconocimiento facial/);
});

test('la marcación final exige GPS, autorización, identidad vigente y foto fresca', async () => {
  const flow = await read('src/public/worker-portal-biometric-flow.js');

  assert.match(flow, /!state\.locationEvidence/);
  assert.match(flow, /verificationStillValid\(\)/);
  assert.match(flow, /!state\.photoBlob/);
  assert.match(flow, /!photoConsent\?\.checked/);
  assert.match(flow, /verification\.verified !== true/);
  assert.match(flow, /captureMode', 'ONLINE_WEB'/);
});
