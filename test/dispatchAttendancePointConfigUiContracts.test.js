import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { filterAttendanceFeatureHtml } from '../src/routes/dispatchBridge.js';

const router = fs.readFileSync('src/routes/dispatchAttendancePointConfig.js', 'utf8');
const bridge = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
const bridgeCore = fs.readFileSync('src/routes/dispatchBridgeCore.js', 'utf8');
const authority = fs.readFileSync('src/modules/dispatch-attendance/application/updatePointConfig.js', 'utf8');
const sourceView = fs.readFileSync('src/views/operacionesClienteOperaciones.ejs', 'utf8');
const renderedView = filterAttendanceFeatureHtml(sourceView, { allowed: true });

test('la configuración administrativa usa una autoridad aislada', () => {
  assert.match(router, /updateDispatchAttendancePointConfig\s*\(\s*prisma\s*,/);
  assert.doesNotMatch(router, /dispatchOperationPoint\.update/);
  assert.match(router, /express\.Router\(\s*\{\s*mergeParams\s*:\s*true\s*,?\s*\}\s*\)/);
  assert.match(router, /router\.post\(\s*['"]\/['"]\s*,/);
});

test('la fachada protege la configuración con permisos de operaciones y asistencia', () => {
  assert.match(bridge, /dispatchAttendancePointConfigRouter/);
  assert.match(bridge, /['"]\/clientes\/:clientId\/operaciones\/:operationId\/asistencia['"]/);
  assert.match(bridge, /requireOps\s*,\s*requireAttendanceAccess\s*,\s*dispatchAttendancePointConfigRouter\s*\(\s*prisma\s*\)/);
  assert.match(bridge, /router\.use\(\s*dispatchBridgeCoreRouter\s*\(\s*\)\s*\)/);
  assert.doesNotMatch(bridgeCore, /dispatchAttendancePointConfigRouter/);
});

test('radio y precisión no son editables y el servidor impone 100/50', () => {
  assert.doesNotMatch(renderedView, /type="number"\s+name="geofenceRadiusMeters"/);
  assert.doesNotMatch(renderedView, /type="number"\s+name="maxLocationAccuracyMeters"/);
  assert.doesNotMatch(router, /req\.body\.geofenceRadiusMeters/);
  assert.doesNotMatch(router, /req\.body\.maxLocationAccuracyMeters/);
  assert.match(authority, /DEFAULT_ATTENDANCE_GEOFENCE_RADIUS_METERS\s*=\s*100/);
  assert.match(authority, /DEFAULT_ATTENDANCE_MAX_LOCATION_ACCURACY_METERS\s*=\s*50/);
  assert.match(renderedView, /Radio permitido:\s*100 m/);
  assert.match(renderedView, /Precisión GPS:\s*50 m o mejor/);
});

test('el mapa reemplaza la escritura manual de coordenadas', () => {
  assert.match(renderedView, /type="hidden"\s+name="attendanceLatitude"/);
  assert.match(renderedView, /type="hidden"\s+name="attendanceLongitude"/);
  assert.doesNotMatch(renderedView, /type="number"\s+name="attendanceLatitude"/);
  assert.doesNotMatch(renderedView, /type="number"\s+name="attendanceLongitude"/);
  assert.match(renderedView, /class="attendance-map"/);
  assert.match(renderedView, /Buscar dirección/);
  assert.match(renderedView, /Usar mi ubicación/);
});

test('Leaflet, búsqueda serializada y geolocalización respetan el contrato', () => {
  assert.match(renderedView, /leaflet@1\.9\.4\/dist\/leaflet\.css/);
  assert.match(renderedView, /leaflet@1\.9\.4\/dist\/leaflet\.js/);
  assert.match(renderedView, /https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
  assert.match(renderedView, /\/admin\/operaciones\/asistencia\/geocodificar/);
  assert.match(renderedView, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(renderedView, /enableHighAccuracy:\s*true/);
  assert.match(renderedView, /maximumAge:\s*0/);
});

test('el formulario conserva booleanos explícitos y elimina las ventanas temporales desde la plantilla', () => {
  assert.match(renderedView, /attendanceEnabledFallback/);
  assert.match(renderedView, /manualAttendanceAllowedFallback/);
  assert.doesNotMatch(sourceView, /name="earlyArrivalWindowMinutes"/);
  assert.doesNotMatch(sourceView, /name="lateToleranceMinutes"/);
  assert.doesNotMatch(sourceView, /name="absenceGraceMinutes"/);
  assert.doesNotMatch(renderedView, /name="earlyArrivalWindowMinutes"/);
  assert.doesNotMatch(renderedView, /name="lateToleranceMinutes"/);
  assert.doesNotMatch(renderedView, /name="absenceGraceMinutes"/);
  assert.match(renderedView, /data-attendance-open-entry-policy="true"/);
  assert.match(renderedView, /Entrada sin ventana configurable/);
  assert.match(renderedView, /Las llegadas tarde se registran y no se bloquean/);
  assert.match(renderedView, /conteo inicia a la hora programada/);
});

test('el render autorizado conserva completa la configuración de asistencia por operación', () => {
  assert.match(renderedView, /<summary>Configurar asistencia<\/summary>/);
  assert.match(renderedView, /class="form-grid compact-form attendance-map-form"/);
  assert.match(renderedView, /name="attendanceEnabled"/);
  assert.match(renderedView, /name="attendancePhotoPolicy"/);
  assert.match(renderedView, /name="manualAttendanceAllowed"/);
  assert.match(renderedView, /class="attendance-map"/);
  assert.match(renderedView, /Guardar asistencia|Guardar y habilitar asistencia/);
});

test('el backend ignora las antiguas ventanas aunque un cliente las envíe', () => {
  assert.doesNotMatch(router, /req\.body\.earlyArrivalWindowMinutes/);
  assert.doesNotMatch(router, /req\.body\.lateToleranceMinutes/);
  assert.doesNotMatch(router, /req\.body\.absenceGraceMinutes/);
  assert.doesNotMatch(authority, /earlyArrivalWindowMinutes:/);
  assert.doesNotMatch(authority, /lateToleranceMinutes:/);
  assert.doesNotMatch(authority, /absenceGraceMinutes:/);
});

test('la ruta administrativa no registra llegadas ni escribe Prisma directamente', () => {
  assert.doesNotMatch(router, /registerDispatchArrival/);
  assert.doesNotMatch(router, /\/public|\/marcar|\/llegada/);
  assert.doesNotMatch(router, /dispatchOperationPoint\.update/);
});