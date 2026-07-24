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

test('el panel de asistencia carga el runtime de mapas antes de inicializar Leaflet', () => {
  assert.match(bridgeSource, /ATTENDANCE_MAP_RELIABILITY_SCRIPT/);
  assert.match(bridgeSource, /view === 'operacionesAsistencia'/);
  assert.match(bridgeSource, /filterAttendanceAdminHtml/);
  assert.match(bridgeSource, /strict-origin-when-cross-origin/);
});

test('el mapa invalida su tamaño antes de recalcular el encuadre', () => {
  const invalidateIndex = runtimeSource.indexOf('map.invalidateSize');
  const fitIndex = runtimeSource.indexOf('originalFitBounds.call', invalidateIndex);
  assert.ok(invalidateIndex >= 0);
  assert.ok(fitIndex > invalidateIndex);
  assert.match(runtimeSource, /requestAnimationFrame/);
  assert.match(runtimeSource, /data-attendance-coordinate-diagnostics/);
  assert.match(runtimeSource, /tileerror/);
});

test('la búsqueda de dirección exige selección explícita y no toma el primer resultado', () => {
  assert.match(runtimeSource, /Confirma el resultado correcto/);
  assert.match(runtimeSource, /Lórren no guardará automáticamente el primer resultado/);
  assert.match(runtimeSource, /data-attendance-geocode-results/);
  assert.doesNotMatch(runtimeSource, /results\s*\[\s*0\s*\]/);
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
  assert.match(bridgeSource, /vuelve a confirmar el punto exacto/);
});
