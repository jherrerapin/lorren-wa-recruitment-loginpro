import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const router = fs.readFileSync('src/routes/dispatchAttendancePointConfig.js', 'utf8');
const bridge = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
const bridgeCore = fs.readFileSync('src/routes/dispatchBridgeCore.js', 'utf8');
const view = fs.readFileSync('src/views/operacionesClienteOperaciones.ejs', 'utf8');

test('la configuración administrativa usa una autoridad aislada', () => {
  assert.match(router, /updateDispatchAttendancePointConfig\(prisma,/);
  assert.doesNotMatch(router, /dispatchOperationPoint\.update/);
  assert.match(router, /express\.Router\(\{ mergeParams: true \}\)/);
  assert.match(router, /router\.post\('\/'/);
});

test('la fachada monta la ruta detrás de requireOps y conserva el router existente intacto', () => {
  assert.match(bridge, /dispatchAttendancePointConfigRouter/);
  assert.match(bridge, /'\/clientes\/:clientId\/operaciones\/:operationId\/asistencia'/);
  assert.match(bridge, /requireOps,[\s\S]*dispatchAttendancePointConfigRouter\(prisma\)/);
  assert.match(bridge, /router\.use\(dispatchBridgeCoreRouter\(\)\)/);
  assert.match(bridgeCore, /export function dispatchBridgeRouter\(\)/);
  assert.doesNotMatch(bridgeCore, /dispatchAttendancePointConfigRouter/);
});

test('el formulario envía booleanos explícitos y límites coherentes', () => {
  assert.match(view, /attendanceEnabledFallback/);
  assert.match(view, /manualAttendanceAllowedFallback/);
  assert.match(view, /name="attendanceLatitude" min="-90" max="90" step="0\.0000001"/);
  assert.match(view, /name="attendanceLongitude" min="-180" max="180" step="0\.0000001"/);
  assert.match(view, /name="geofenceRadiusMeters" min="20" max="2000" step="1"/);
  assert.match(view, /name="maxLocationAccuracyMeters" min="5" max="500" step="1"/);
  assert.match(view, /name="earlyArrivalWindowMinutes" min="0" max="240" step="1"/);
  assert.match(view, /name="lateToleranceMinutes" min="0" max="240" step="1"/);
  assert.match(view, /name="absenceGraceMinutes" min="0" max="240" step="1"/);
});

test('la fase no expone marcación pública', () => {
  assert.doesNotMatch(router, /registerDispatchArrival/);
  assert.doesNotMatch(router, /\/public|\/marcar|\/llegada/);
  assert.match(view, /no publica todavía un enlace de marcación/);
});
