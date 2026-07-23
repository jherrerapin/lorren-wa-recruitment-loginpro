import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const router = fs.readFileSync('src/routes/dispatchAttendancePointConfig.js', 'utf8');
const bridge = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
const bridgeCore = fs.readFileSync('src/routes/dispatchBridgeCore.js', 'utf8');
const authority = fs.readFileSync('src/modules/dispatch-attendance/application/updatePointConfig.js', 'utf8');
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

test('radio y precisión no son editables y el servidor impone 100/50', () => {
  assert.doesNotMatch(view, /type="number"\s+name="geofenceRadiusMeters"/);
  assert.doesNotMatch(view, /type="number"\s+name="maxLocationAccuracyMeters"/);
  assert.doesNotMatch(router, /req\.body\.geofenceRadiusMeters/);
  assert.doesNotMatch(router, /req\.body\.maxLocationAccuracyMeters/);
  assert.match(authority, /DEFAULT_ATTENDANCE_GEOFENCE_RADIUS_METERS\s*=\s*100/);
  assert.match(authority, /DEFAULT_ATTENDANCE_MAX_LOCATION_ACCURACY_METERS\s*=\s*50/);
  assert.match(view, /Radio permitido:\s*100 m/);
  assert.match(view, /Precisión GPS:\s*50 m o mejor/);
});

test('el mapa reemplaza la escritura manual de coordenadas', () => {
  assert.match(view, /type="hidden"\s+name="attendanceLatitude"/);
  assert.match(view, /type="hidden"\s+name="attendanceLongitude"/);
  assert.doesNotMatch(view, /type="number"\s+name="attendanceLatitude"/);
  assert.doesNotMatch(view, /type="number"\s+name="attendanceLongitude"/);
  assert.match(view, /class="attendance-map"/);
  assert.match(view, /Buscar dirección/);
  assert.match(view, /Usar mi ubicación/);
  assert.match(view, /marker\(point,\s*\{\s*draggable:\s*true\s*\}\)/);
  assert.match(view, /map\.on\(['"]click['"]/);
  assert.match(view, /L\.circle\(point,\s*\{\s*radius:\s*ATTENDANCE_GEOFENCE_RADIUS_METERS\s*\}\)/);
});

test('Leaflet, OpenStreetMap, búsqueda explícita y geolocalización respetan el contrato', () => {
  assert.match(view, /leaflet@1\.9\.4\/dist\/leaflet\.css/);
  assert.match(view, /sha256-p4NxAoJBhIIN\+hmNHrzRCf9tD\/miZyoHS5obTRR9BMY=/);
  assert.match(view, /leaflet@1\.9\.4\/dist\/leaflet\.js/);
  assert.match(view, /sha256-20nQCchB9coqIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo=/);
  assert.match(view, /https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
  assert.match(view, /OpenStreetMap<\/a> contributors/);
  assert.match(view, /https:\/\/nominatim\.openstreetmap\.org\/search/);
  assert.match(view, /respectNominatimRateLimit/);
  assert.doesNotMatch(view, /attendance-address-search['"]\)\?\.addEventListener\(['"]input/);
  assert.match(view, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(view, /enableHighAccuracy:\s*true/);
  assert.match(view, /maximumAge:\s*0/);
});

test('el formulario conserva booleanos explícitos y límites operativos', () => {
  assert.match(view, /attendanceEnabledFallback/);
  assert.match(view, /manualAttendanceAllowedFallback/);
  assert.match(view, /name="earlyArrivalWindowMinutes"\s+min="0"\s+max="240"/);
  assert.match(view, /name="lateToleranceMinutes"\s+min="0"\s+max="240"/);
  assert.match(view, /name="absenceGraceMinutes"\s+min="0"\s+max="240"/);
  assert.match(view, /Selecciona primero la ubicación exacta del punto/);
});

test('la ruta administrativa no registra llegadas ni escribe Prisma directamente', () => {
  assert.doesNotMatch(router, /registerDispatchArrival/);
  assert.doesNotMatch(router, /\/public|\/marcar|\/llegada/);
  assert.doesNotMatch(router, /dispatchOperationPoint\.update/);
});
