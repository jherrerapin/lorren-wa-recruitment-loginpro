import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loader = fs.readFileSync('src/public/worker-biometric.js', 'utf8');
const bootstrap = fs.readFileSync('src/public/worker-biometric-core.js', 'utf8');
const mobile = fs.readFileSync('src/public/worker-biometric-mobile.js', 'utf8');


test('el bootstrap se carga antes del único motor y del controlador vigente', () => {
  const bootstrapPosition = loader.indexOf('worker-biometric-core.js');
  const enginePosition = loader.indexOf('worker-biometric-mobile.js');
  const flowPosition = loader.indexOf('worker-portal-biometric-flow.js');
  assert.ok(bootstrapPosition >= 0);
  assert.ok(enginePosition > bootstrapPosition);
  assert.ok(flowPosition > enginePosition);
  assert.doesNotMatch(loader, /worker-portal-hardening\.js/);

  assert.match(bootstrap, /humanFaceSimilarity/);
  assert.match(bootstrap, /installPortalResponseGuard/);
  assert.doesNotMatch(bootstrap, /function humanConfig|captureEnrollment|captureVerification|getUserMedia|human\.detect/);
  assert.match(mobile, /function humanConfig/);
  assert.match(mobile, /async function captureEnrollment/);
  assert.match(mobile, /async function captureVerification/);
  assert.match(mobile, /navigator\.mediaDevices\.getUserMedia/);
});


test('la detección facial usa fallback móvil y precalienta los modelos', () => {
  assert.match(mobile, /\['webgl', 'wasm', 'cpu'\]/);
  assert.match(mobile, /human\.load\(\)/);
  assert.match(mobile, /human\.warmup\(\)/);
  assert.match(mobile, /BASELINE_TIMEOUT_MS = 14_000/);
  assert.match(mobile, /CHALLENGE_TIMEOUT_MS = 10_000/);
  assert.match(mobile, /FINAL_TIMEOUT_MS = 14_000/);
  assert.match(mobile, /waitForVideoReady/);
  assert.match(mobile, /videoWidth > 0/);
});


test('vivacidad, anti-spoof y descriptor deben coincidir en cada muestra', () => {
  assert.match(mobile, /scores\.realScore < MIN_REAL_SCORE/);
  assert.match(mobile, /scores\.liveScore < MIN_LIVE_SCORE/);
  assert.match(mobile, /descriptor:\s*normalizeDescriptor\(detected\.face\.embedding\)/);
  assert.match(mobile, /realScore:\s*scores\.realScore/);
  assert.match(mobile, /liveScore:\s*scores\.liveScore/);
  assert.match(mobile, /ArrayBuffer\.isView\(value\)/);
  assert.doesNotMatch(mobile, /bestReal = Math\.max/);
  assert.doesNotMatch(mobile, /bestLive = Math\.max/);
  assert.doesNotMatch(mobile, /Math\.max\(modelLiveScore,\s*MIN_LIVE_SCORE\)/);
});


test('cada verificación conserva desafío activo y siete muestras desde video vivo', () => {
  assert.match(mobile, /challenge\.action === 'TURN_SIDE'/);
  assert.match(mobile, /geometry\.faceRatio >= closerTarget/);
  assert.match(mobile, /const VERIFICATION_STAGE_SAMPLES = 2/);
  assert.match(mobile, /const REQUIRED_ACTION_FRAMES = 3/);
  assert.match(mobile, /actionDescriptors:\s*action\.descriptors/);
  assert.match(mobile, /actionLiveScores:\s*action\.liveScores/);
  assert.match(mobile, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(mobile, /capturePhoto\(video\)/);
  assert.doesNotMatch(mobile, /input type=["']file/);
});
