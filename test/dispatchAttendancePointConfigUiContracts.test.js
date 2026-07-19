import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const router = fs.readFileSync('src/routes/dispatchAttendancePointConfig.js', 'utf8');
const bridge = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
const bridgeCore = fs.readFileSync('src/routes/dispatchBridgeCore.js', 'utf8');
const view = fs.readFileSync('src/views/operacionesClienteOperaciones.ejs', 'utf8');

test('la configuración administrativa usa una autoridad aislada', () => {
  assert.match(router, /updateDispatchAttendancePointConfig\s*\(\s*prisma\s*,/);
  assert.doesNotMatch(router, /dispatchOperationPoint\.update/);
  assert.match(router, /express\.Router\(\s*\{\s*mergeParams\s*:\s*true\s*,?\s*\}\s*\)/);
  assert.match(router, /router\.post\(\s*['"]\/['"]\s*,/);
});

test('la fachada monta la ruta detrás de requireOps y conserva el router existente intacto', () => {
  assert.match(bridge, /dispatchAttendancePointConfigRouter/);
  assert.match(bridge, /['"]\/clientes\/:clientId\/operaciones\/:operationId\/asistencia['"]/);
  assert.match(bridge, /requireOps\s*,\s*dispatchAttendancePointConfigRouter\s*\(\s*prisma\s*\)/);
  assert.match(bridge, /router\.use\(\s*dispatchBridgeCoreRouter\s*\(\s*\)\s*\)/);
  assert.match(bridgeCore, /export\s+function\s+dispatchBridgeRouter\s*\(\s*\)/);
  assert.doesNotMatch(bridgeCore, /dispatchAttendancePointConfigRouter/);
});

test('el formulario envía booleanos explícitos y límites coherentes', () => {
  assert.match(view, /attendanceEnabledFallback/);
  assert.match(view, /manualAttendanceAllowedFallback/);
  assert.match(view, /name\s*=\s*['"]attendanceLatitude['"][^>]*min\s*=\s*['"]-90['"][^>]*max\s*=\s*['"]90['"][^>]*step\s*=\s*['"]0\.0000001['"]/);
  assert.match(view, /name\s*=\s*['"]attendanceLongitude['"][^>]*min\s*=\s*['"]-180['"][^>]*max\s*=\s*['"]180['"][^>]*step\s*=\s*['"]0\.0000001['"]/);
  assert.match(view, /name\s*=\s*['"]geofenceRadiusMeters['"][^>]*min\s*=\s*['"]20['"][^>]*max\s*=\s*['"]2000['"][^>]*step\s*=\s*['"]1['"]/);
  assert.match(view, /name\s*=\s*['"]maxLocationAccuracyMeters['"][^>]*min\s*=\s*['"]5['"][^>]*max\s*=\s*['"]500['"][^>]*step\s*=\s*['"]1['"]/);
  assert.match(view, /name\s*=\s*['"]earlyArrivalWindowMinutes['"][^>]*min\s*=\s*['"]0['"][^>]*max\s*=\s*['"]240['"]/);
  assert.match(view, /name\s*=\s*['"]lateToleranceMinutes['"][^>]*min\s*=\s*['"]0['"][^>]*max\s*=\s*['"]240['"]/);
  assert.match(view, /name\s*=\s*['"]absenceGraceMinutes['"][^>]*min\s*=\s*['"]0['"][^>]*max\s*=\s*['"]240['"]/);
});

test('la fase no expone marcación pública', () => {
  assert.doesNotMatch(router, /registerDispatchArrival/);
  assert.doesNotMatch(router, /\/public|\/marcar|\/llegada/);
  assert.match(view, /no publica todavía un enlace de marcación/);
});
