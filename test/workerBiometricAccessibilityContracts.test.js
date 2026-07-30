import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el portal carga el ajuste móvil antes de la experiencia accesible', async () => {
  const loader = await read('src/public/worker-biometric.js');
  const corePosition = loader.indexOf('/public/worker-biometric-core.js');
  const mobilePosition = loader.indexOf('/public/worker-biometric-mobile.js');
  const accessibilityPosition = loader.indexOf('/public/worker-biometric-accessibility.js');

  assert.ok(corePosition >= 0);
  assert.ok(mobilePosition > corePosition);
  assert.ok(accessibilityPosition > mobilePosition);
  assert.match(loader, /\/public\/worker-portal-hardening\.js/);
  assert.match(loader, /\/operaciones\/portal\/offline\.js/);
});

test('la ventana móvil ocupa la pantalla y mantiene controles grandes', async () => {
  const source = await read('src/public/worker-biometric-accessibility.js');

  assert.match(source, /#mark-dialog[\s\S]*width:\s*100vw/);
  assert.match(source, /height:\s*100dvh/);
  assert.match(source, /#close-mark[\s\S]*52px/);
  assert.match(source, /#photo-consent[\s\S]*30px/);
  assert.match(source, /#capture-photo,[\s\S]*#submit-mark[\s\S]*min-height:\s*60px/);
  assert.match(source, /#mark-dialog \.dialog-actions[\s\S]*position:\s*sticky/);
  assert.match(source, /font-size:\s*clamp\(21px,\s*5\.8vw,\s*28px\)/);
  assert.doesNotMatch(source, /Para que te reconozca correctamente/);
});

test('un toque permite un reintento transitorio automático sin interceptar la red', async () => {
  const source = await read('src/public/worker-biometric-accessibility.js');

  assert.match(source, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(source, /timeoutMs:\s*12_000/);
  assert.match(source, /Reintentando automáticamente/);
  assert.match(source, /singlePressVerification:\s*true/);
  assert.doesNotMatch(source, /window\.fetch\s*=/);
  assert.doesNotMatch(source, /getUserMedia\s*=/);
});

test('el motor móvil elimina conteos técnicos y reduce el recorrido facial', async () => {
  const source = await read('src/public/worker-biometric-mobile.js');

  assert.match(source, /const CAPTURE_TIMEOUT_MS = 22_000/);
  assert.match(source, /async function prepare\(\)/);
  assert.match(source, /Gira el rostro hacia tu hombro derecho/);
  assert.match(source, /Rostro detectado\. Mantén la posición/);
  assert.doesNotMatch(source, /Rostro detectado · \$\{descriptors\.length\} de \$\{samplesRequired\}/);
  assert.match(source, /collectStableFront\(human, video, onStatus, timeoutAt, 1\)/);
  assert.match(source, /averageDescriptors\(\[\.\.\.baseline\.descriptors, \.\.\.final\.descriptors\]\)/);
  assert.match(source, /faces\.length !== 1/);
  assert.match(source, /MIN_REAL_SCORE = 0\.55/);
  assert.match(source, /MIN_LIVE_SCORE = 0\.55/);
});