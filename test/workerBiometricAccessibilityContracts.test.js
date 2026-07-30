import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el portal conserva el refuerzo visual después del motor facial', async () => {
  const loader = await read('src/public/worker-biometric.js');
  const corePosition = loader.indexOf('/public/worker-biometric-core.js');
  const accessibilityPosition = loader.indexOf('/public/worker-biometric-accessibility.js');

  assert.ok(corePosition >= 0);
  assert.ok(accessibilityPosition > corePosition);
  assert.match(loader, /\/public\/worker-biometric-mobile\.js/);
  assert.match(loader, /\/public\/worker-portal-hardening\.js/);
  assert.match(loader, /\/operaciones\/portal\/offline\.js/);
});

test('solo la instrucción dinámica queda grande y en alto contraste', async () => {
  const source = await read('src/public/worker-biometric-accessibility.js');

  assert.match(source, /#biometric-instruction/);
  assert.match(source, /font-size:\s*clamp\(21px,\s*5\.8vw,\s*28px\)/);
  assert.match(source, /font-weight:\s*850/);
  assert.match(source, /border:\s*2px solid #176c36/);
  assert.match(source, /aria-live', 'assertive/);
  assert.doesNotMatch(source, /Para que te reconozca correctamente/);
  assert.doesNotMatch(source, /gafas transparentes/);
  assert.doesNotMatch(source, /reflejo fuerte/);
  assert.doesNotMatch(source, /lorren-biometric-visible-help/);
});

test('la verificación promedia tres capturas estables y conserva las barreras', async () => {
  const source = await read('src/public/worker-biometric-core.js');

  assert.match(source, /const CAPTURE_TIMEOUT_MS = 30_000/);
  assert.match(source, /const VERIFICATION_SAMPLES = 3/);
  assert.match(source, /descriptor:\s*averageDescriptors\(descriptors\)/);
  assert.match(source, /Math\.min\(\.\.\.scores\.map/);
  assert.match(source, /scores\.realScore >= MIN_REAL_SCORE/);
  assert.match(source, /scores\.liveScore >= MIN_LIVE_SCORE/);
  assert.match(source, /faces\.length !== 1/);
});

test('la mejora visual no reemplaza ni intercepta la API de reconocimiento', async () => {
  const source = await read('src/public/worker-biometric-accessibility.js');

  assert.doesNotMatch(source, /LorrenWorkerBiometric\s*=/);
  assert.doesNotMatch(source, /window\.fetch\s*=/);
  assert.doesNotMatch(source, /captureVerification\s*=/);
  assert.doesNotMatch(source, /getUserMedia\s*=/);
});
