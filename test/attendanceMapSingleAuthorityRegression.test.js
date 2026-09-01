import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loaderSource = fs.readFileSync(
  new URL('../src/public/attendance-admin-runtime.js', import.meta.url),
  'utf8'
);
const coreSource = fs.readFileSync(
  new URL('../src/public/attendance-admin-runtime-core.js', import.meta.url),
  'utf8'
);
const reliabilitySource = fs.readFileSync(
  new URL('../src/public/attendance-map-reliability.js', import.meta.url),
  'utf8'
);
const bridgeSource = fs.readFileSync(
  new URL('../src/routes/dispatchBridge.js', import.meta.url),
  'utf8'
);

test('Asistencia mantiene una sola autoridad cliente para teselas aunque reactive el reparador de viewport', () => {
  assert.match(loaderSource, /attendance-admin-runtime-core\.js/);
  assert.doesNotMatch(coreSource, /tileLayer|TileLayer|OSM_TILE_URL|IDECA_TILE_URL|tileerror|TILE_TIMEOUT_MS/);
  assert.match(
    bridgeSource,
    /ATTENDANCE_MAP_RELIABILITY_SCRIPT = '\/public\/attendance-map-reliability\.js'/
  );
  assert.match(bridgeSource, /filterAttendanceAdminHtml/);
  assert.match(reliabilitySource, /leaflet\.tileLayer = function reliableAttendanceTileLayer/);
  assert.match(reliabilitySource, /tile\.openstreetmap\.org/);
  assert.match(reliabilitySource, /Mapa_Referencia\/mapa_base_3857/);
  assert.match(reliabilitySource, /tileerror/);
  assert.match(reliabilitySource, /ResizeObserver/);
});

test('el viewport administrativo se inicializa aunque fitBounds diferido todavía no haya corrido', () => {
  assert.match(coreSource, /function initialViewport\(container\)/);
  assert.match(coreSource, /classList\?\.contains\('failure-attempt-map'\)/);
  assert.match(coreSource, /dataset\?\.defaultMapMode/);
  assert.match(coreSource, /haversineMeters\(operation, mark\)/);
  assert.match(coreSource, /!Number\.isFinite\(currentZoom\)/);
  assert.match(coreSource, /map\.setView\(viewport\.center, viewport\.zoom, \{ animate: false \}\)/);
  assert.match(coreSource, /map\.invalidateSize\(\{ pan: false, debounceMoveend: true \}\)/);
  assert.doesNotMatch(coreSource, /fitBounds/);
});

test('un mapa de intento fallido puede reintentar el fondo sin recargar toda la página', () => {
  assert.match(reliabilitySource, /function retryManagedBaseLayer\(map\)/);
  assert.match(reliabilitySource, /state\.exhausted = true/);
  assert.match(reliabilitySource, /state\.attempted\.clear\(\)/);
  assert.match(reliabilitySource, /\[data-failure-map-details\]/);
  assert.match(reliabilitySource, /\.attendance-map, \.failure-attempt-map/);
  assert.match(reliabilitySource, /window\.addEventListener\('online', refreshAllMaps/);
  assert.match(reliabilitySource, /Cierra y vuelve a abrir el mapa o recupera la conexión para reintentar/);
});

test('reactivar el reparador de viewport conserva los demás módulos administrativos', () => {
  assert.match(loaderSource, /lorren-dialog\.js/);
  assert.match(loaderSource, /attendance-admin-runtime-core\.js/);
  assert.match(loaderSource, /attendance-admin-compact\.js/);
  assert.match(loaderSource, /attendance-admin-manual-workday\.js/);
  assert.match(loaderSource, /attendance-admin-clear-marks\.js/);
  assert.match(loaderSource, /attendance-admin-billing-counter\.js/);
});