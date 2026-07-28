import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loader = fs.readFileSync('src/public/worker-biometric.js', 'utf8');
const mobile = fs.readFileSync('src/public/worker-biometric-mobile.js', 'utf8');


test('el estabilizador móvil se carga entre el núcleo y el endurecimiento', () => {
  const core = loader.indexOf('worker-biometric-core.js');
  const mobileLayer = loader.indexOf('worker-biometric-mobile.js');
  const hardening = loader.indexOf('worker-portal-hardening.js');
  assert.ok(core >= 0);
  assert.ok(mobileLayer > core);
  assert.ok(hardening > mobileLayer);
});


test('la detección facial usa fallback móvil y precalienta los modelos', () => {
  assert.match(mobile, /\['webgl', 'wasm', 'cpu'\]/);
  assert.match(mobile, /human\.load\(\)/);
  assert.match(mobile, /human\.warmup\(\)/);
  assert.match(mobile, /CAPTURE_TIMEOUT_MS = 45_000/);
  assert.match(mobile, /waitForVideoReady/);
  assert.match(mobile, /videoWidth > 0/);
});


test('vivacidad, anti-spoof y descriptor se acumulan sin exigir el mismo fotograma', () => {
  assert.match(mobile, /bestReal = Math\.max\(bestReal, scores\.realScore\)/);
  assert.match(mobile, /bestLive = Math\.max\(bestLive, scores\.liveScore\)/);
  assert.match(mobile, /descriptors\.push\(descriptor\)/);
  assert.match(mobile, /bestReal >= MIN_REAL_SCORE && bestLive >= MIN_LIVE_SCORE/);
  assert.match(mobile, /ArrayBuffer\.isView\(value\)/);
  assert.doesNotMatch(mobile, /scores\.realScore >= MIN_REAL_SCORE && scores\.liveScore >= MIN_LIVE_SCORE && detected\.face\.embedding/);
});


test('cada verificación conserva desafío activo y captura desde video vivo', () => {
  assert.match(mobile, /challenge\.action === 'TURN_SIDE'/);
  assert.match(mobile, /detected\.quality\.faceRatio >= closerTarget/);
  assert.match(mobile, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(mobile, /capturePhoto\(video\)/);
  assert.doesNotMatch(mobile, /input type=["']file/);
});
