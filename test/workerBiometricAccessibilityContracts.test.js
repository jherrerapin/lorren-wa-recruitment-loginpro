import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el portal carga la guía biométrica accesible después del motor facial', async () => {
  const loader = await read('src/public/worker-biometric.js');
  const corePosition = loader.indexOf('/public/worker-biometric-core.js');
  const accessibilityPosition = loader.indexOf('/public/worker-biometric-accessibility.js');

  assert.ok(corePosition >= 0);
  assert.ok(accessibilityPosition > corePosition);
  assert.match(loader, /\/public\/worker-biometric-mobile\.js/);
  assert.match(loader, /\/public\/worker-portal-hardening\.js/);
  assert.match(loader, /\/operaciones\/portal\/offline\.js/);
});

test('la instrucción facial es grande, de alto contraste y explica el uso de gafas', async () => {
  const source = await read('src/public/worker-biometric-accessibility.js');

  assert.match(source, /font-size:\s*clamp\(20px,\s*5\.5vw,\s*26px\)/);
  assert.match(source, /font-weight:\s*850/);
  assert.match(source, /border:\s*2px solid #176c36/);
  assert.match(source, /aria-live', 'assertive/);
  assert.match(source, /centra todo tu rostro dentro del óvalo/);
  assert.match(source, /gafas transparentes/);
  assert.match(source, /reflejo fuerte/);
  assert.match(source, /Solo tú debes aparecer frente a la cámara/);
});

test('la mejora visual no reemplaza ni intercepta la API de reconocimiento', async () => {
  const source = await read('src/public/worker-biometric-accessibility.js');

  assert.doesNotMatch(source, /LorrenWorkerBiometric\s*=/);
  assert.doesNotMatch(source, /window\.fetch\s*=/);
  assert.doesNotMatch(source, /captureVerification\s*=/);
  assert.doesNotMatch(source, /getUserMedia\s*=/);
});
