import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('DispatchWorker conserva la bandera persistente de auxiliar de prueba', () => {
  const schema = readSource('prisma/schema.prisma');
  const workerStart = schema.indexOf('model DispatchWorker {');
  const workerEnd = schema.indexOf('\n}', workerStart);
  assert.ok(workerStart >= 0 && workerEnd > workerStart);
  const workerModel = schema.slice(workerStart, workerEnd);
  assert.match(workerModel, /isTestProfile\s+Boolean\s+@default\(false\)/);
});

test('solo DEV puede cambiar la bandera de auxiliar de prueba', () => {
  const source = readSource('src/routes/dispatchWorkerStats.js');
  assert.match(
    source,
    /router\.post\(\s*['"]\/personal\/:workerId\/test-profile['"]\s*,\s*requireOps\s*,\s*requireDev\s*,\s*express\.urlencoded/s
  );
  assert.match(source, /data:\s*\{\s*isTestProfile\s*\}/);
  assert.match(source, /DISPATCH_WORKER_TEST_PROFILE_UPDATED/);
  assert.match(source, /billingExcluded:\s*isTestProfile/);
});

test('el selector de prueba se agrega únicamente al render DEV de Personal', () => {
  const source = readSource('src/routes/dispatchWorkerStats.js');
  const devGateStart = source.indexOf("router.get('/personal', requireOps");
  const testProfileRouteStart = source.indexOf("'/personal/:workerId/test-profile'", devGateStart);
  assert.ok(devGateStart >= 0 && testProfileRouteStart > devGateStart);
  const devGate = source.slice(devGateStart, testProfileRouteStart);

  assert.match(devGate, /if \(role !== 'dev'\) return next\(\)/);
  assert.match(devGate, /installTestResetRenderGate\(res, next\)/);
  assert.match(source, /injectTestProfileControls\(html, renderLocals\.workers\)/);
  assert.match(source, /data-dev-test-profile-column>Prueba/);
  assert.match(source, /name=\"isTestProfile\" value=\"true\"/);
  assert.match(source, /onchange=\"this\.form\.submit\(\)\"/);
});

test('los auxiliares de prueba quedan ocultos de los renders no DEV', () => {
  const source = readSource('src/routes/dispatchWorkerStats.js');
  assert.match(source, /function installTestProfileVisibilityGate\(req, res, next\)/);
  assert.match(source, /if \(currentRole\(req\) === 'dev'\) return next\(\)/);
  assert.match(source, /value\?\.isTestProfile === true \|\| value\?\.worker\?\.isTestProfile === true/);
  assert.match(source, /router\.use\(installTestProfileVisibilityGate\)/);
  assert.match(source, /sanitized\.serviceRequests = sanitized\.serviceRequests\.map\(hideTestAssignmentsFromRequest\)/);
  assert.match(source, /sanitized\.selectedServiceRequest = hideTestAssignmentsFromRequest\(sanitized\.selectedServiceRequest\)/);
});

test('un no DEV tampoco puede abrir por URL directa el historial de un auxiliar de prueba', () => {
  const source = readSource('src/routes/dispatchWorkerStats.js');
  assert.match(
    source,
    /if \(!worker \|\| \(worker\.isTestProfile === true && currentRole\(req\) !== 'dev'\)\)\s*\{\s*return res\.status\(404\)\.send\('Auxiliar no encontrado'\);/s
  );
});

test('marcar un auxiliar como prueba queda ligado a exclusión de facturación', () => {
  const source = readSource('src/routes/dispatchWorkerStats.js');
  assert.match(source, /marcado como prueba\. Queda excluido del contador de auxiliares facturables/);
  assert.match(source, /retirado de prueba\. Volverá a ser elegible para el contador/);
});
