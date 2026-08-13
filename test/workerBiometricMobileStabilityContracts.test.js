import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loader = fs.readFileSync('src/public/worker-biometric.js', 'utf8');
const bootstrap = fs.readFileSync('src/public/worker-biometric-core.js', 'utf8');
const mobile = fs.readFileSync('src/public/worker-biometric-mobile.js', 'utf8');


test('el bootstrap solo publica la versión antes del único motor vigente', () => {
  const bootstrapPosition = loader.indexOf('worker-biometric-core.js');
  const enginePosition = loader.indexOf('worker-biometric-mobile.js');
  const flowPosition = loader.indexOf('worker-portal-biometric-flow.js');
  assert.ok(bootstrapPosition >= 0);
  assert.ok(enginePosition > bootstrapPosition);
  assert.ok(flowPosition > enginePosition);
  assert.doesNotMatch(loader, /worker-portal-hardening\.js/);

  assert.match(bootstrap, /MODEL_VERSION = 'human-3\.3\.6-faceres'/);
  assert.match(bootstrap, /Object\.freeze\(\{ MODEL_VERSION \}\)/);
  assert.doesNotMatch(bootstrap, /humanFaceSimilarity|installPortalResponseGuard|window\.fetch|requiresReview/);
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


test('vivacidad, anti-spoof y descriptor deben coincidir en la muestra aceptada', () => {
  assert.match(mobile, /scores\.realScore < MIN_REAL_SCORE/);
  assert.match(mobile, /scores\.liveScore < MIN_LIVE_SCORE/);
  assert.match(mobile, /descriptor = normalizeDescriptor\(detected\.face\.embedding\)/);
  assert.match(mobile, /samples\.push\(\{\s*descriptor,/);
  assert.match(mobile, /realScore:\s*scores\.realScore/);
  assert.match(mobile, /liveScore:\s*scores\.liveScore/);
  assert.match(mobile, /ArrayBuffer\.isView\(value\)/);
  assert.doesNotMatch(mobile, /bestReal = Math\.max/);
  assert.doesNotMatch(mobile, /bestLive = Math\.max/);
  assert.doesNotMatch(mobile, /Math\.max\(modelLiveScore,\s*MIN_LIVE_SCORE\)/);
});


test('una sola muestra exige cinco segundos continuos de rostro válido antes de capturar', () => {
  const start = mobile.indexOf('async function collectStableFront');
  const end = mobile.indexOf('\n  async function captureEnrollment', start);
  assert.ok(start >= 0 && end > start);
  const source = mobile.slice(start, end);

  assert.match(mobile, /const MIN_STABLE_FACE_DURATION_MS = 5_000/);
  assert.match(source, /let stableStartedAt = null/);
  assert.match(source, /function resetStableWindow\(\) \{\s*stableStartedAt = null/);
  assert.match(source, /if \(!detected \|\| !frontFacing\(detected\.face\)\) \{\s*resetStableWindow\(\)/);

  const realScoreBranch = source.match(/if \(scores\.realScore < MIN_REAL_SCORE\) \{([\s\S]*?)\n      \}/)?.[1] || '';
  const liveScoreBranch = source.match(/if \(scores\.liveScore < MIN_LIVE_SCORE\) \{([\s\S]*?)\n      \}/)?.[1] || '';
  const descriptorFailure = source.match(/catch \{([\s\S]*?)No se pudieron leer los rasgos/)?.[1] || '';
  assert.match(realScoreBranch, /resetStableWindow\(\)/);
  assert.match(liveScoreBranch, /resetStableWindow\(\)/);
  assert.match(descriptorFailure, /resetStableWindow\(\)/);

  const timerPosition = source.indexOf('if (stableStartedAt === null) stableStartedAt = Date.now();');
  const thresholdPosition = source.indexOf('stableElapsedMs < MIN_STABLE_FACE_DURATION_MS');
  const capturePosition = source.indexOf('samples.push({');
  assert.ok(timerPosition >= 0);
  assert.ok(thresholdPosition > timerPosition);
  assert.ok(capturePosition > thresholdPosition, 'la muestra solo se guarda después de superar la ventana estable');
  assert.match(source, /secondsRemaining = Math\.max\(1, Math\.ceil/);
  assert.match(source, /Mantén el rostro de frente y quieto/);
});


test('la verificación móvil conserva cámara viva y una sola muestra frontal', () => {
  assert.match(mobile, /challenge\.action === 'TURN_SIDE'/);
  assert.match(mobile, /geometry\.faceRatio >= closerTarget/);
  assert.match(mobile, /const VERIFICATION_STAGE_SAMPLES = 1/);
  assert.match(mobile, /const REQUIRED_ACTION_FRAMES = 3/);
  assert.match(mobile, /actionDescriptors:\s*action\.descriptors/);
  assert.match(mobile, /actionLiveScores:\s*action\.liveScores/);
  assert.match(mobile, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(mobile, /capturePhoto\(video\)/);
  assert.doesNotMatch(mobile, /input type=["']file/);
});