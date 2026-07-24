import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridgeSource = fs.readFileSync(
  new URL('../src/routes/dispatchBridge.js', import.meta.url),
  'utf8'
);
const runtimeSource = fs.readFileSync(
  new URL('../src/public/attendance-map-reliability.js', import.meta.url),
  'utf8'
);
const adminViewSource = fs.readFileSync(
  new URL('../src/views/operacionesAsistencia.ejs', import.meta.url),
  'utf8'
);

test('el panel de asistencia carga el runtime local de confiabilidad cartográfica', () => {
  assert.match(bridgeSource, /ATTENDANCE_MAP_RELIABILITY_SCRIPT/);
  assert.match(bridgeSource, /view === 'operacionesAsistencia'/);
  assert.match(bridgeSource, /filterAttendanceAdminHtml/);
  assert.match(bridgeSource, /strict-origin-when-cross-origin/);
  assert.match(runtimeSource, /data-lorren-leaflet-fallback/);
  assert.match(runtimeSource, /LEAFLET_CSS_INTEGRITY = 'sha256-p4NxAoJBhIIN\+hmNHrzRCf9tD\/miZyoHS5obTRR9BMY='/);
  assert.doesNotMatch(runtimeSource, /hmNHRzRCf9tD/);
  assert.match(adminViewSource, /leaflet@1\.9\.4/);
});

test('el mapa invalida su tamaño antes de recalcular el encuadre y observa cambios reales del contenedor', () => {
  const invalidateIndex = runtimeSource.indexOf('map.invalidateSize');
  const fitIndex = runtimeSource.indexOf('originalFitBounds.call', invalidateIndex);
  assert.ok(invalidateIndex >= 0);
  assert.ok(fitIndex > invalidateIndex);
  assert.match(runtimeSource, /requestAnimationFrame/);
  assert.match(runtimeSource, /ResizeObserver/);
  assert.match(runtimeSource, /\[data-attendance-card\]/);
  assert.match(runtimeSource, /dataset\.attendanceCoordinateDiagnostics/);
  assert.match(runtimeSource, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(runtimeSource, /google\.com\/maps/);
});

test('usa dos fondos independientes en Bogotá y cambia automáticamente cuando fallan teselas', () => {
  assert.match(runtimeSource, /tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
  assert.match(runtimeSource, /Mapa_Referencia\/mapa_base_3857\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}/);
  assert.match(runtimeSource, /\['ideca', 'osm'\]/);
  assert.match(runtimeSource, /tileerror/);
  assert.match(runtimeSource, /activateProvider\(map, nextProvider\)/);
  assert.match(runtimeSource, /Fondo cartográfico activo/);
  assert.match(runtimeSource, /Los marcadores, la geocerca y las coordenadas siguen siendo válidos/);
});

test('la búsqueda agrega contexto, acepta Enter y exige selección explícita', () => {
  assert.match(runtimeSource, /inferCityFromSearchInput/);
  assert.match(runtimeSource, /contextualSearchQuery/);
  assert.match(runtimeSource, /params\.set\('city', city\)/);
  assert.match(runtimeSource, /event\.key !== 'Enter'/);
  assert.match(runtimeSource, /Confirma el resultado correcto/);
  assert.match(runtimeSource, /nunca guardará el primer resultado sin confirmación/);
  assert.match(runtimeSource, /data-attendance-geocode-results/);
  assert.doesNotMatch(runtimeSource, /results\s*\[\s*0\s*\]/);
  assert.doesNotMatch(runtimeSource, /fetch\(`https:\/\/nominatim/);
});

test('usar mi ubicación conserva varias lecturas y selecciona la de mejor precisión', () => {
  assert.match(runtimeSource, /navigator\.geolocation\.watchPosition/);
  assert.match(runtimeSource, /accuracy < Number\(bestPosition\.coords\.accuracy\)/);
  assert.match(runtimeSource, /TARGET_ACCURACY_METERS = 20/);
  assert.match(runtimeSource, /navigator\.geolocation\.clearWatch/);
});

test('cambiar ciudad o dirección invalida la geocerca antigua', () => {
  assert.match(bridgeSource, /operationLocationChanged/);
  assert.match(bridgeSource, /data\.attendanceEnabled = false/);
  assert.match(bridgeSource, /data\.attendanceLatitude = null/);
  assert.match(bridgeSource, /data\.attendanceLongitude = null/);
  assert.match(bridgeSource, /!req\.canAccessAttendanceFeature/);
  assert.match(bridgeSource, /requiere acceso autorizado a Asistencia/);
  assert.match(bridgeSource, /vuelve a confirmar el punto exacto/);
});
