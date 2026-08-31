import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loaderSource = fs.readFileSync(
  new URL('../src/public/attendance-admin-runtime.js', import.meta.url),
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

test('Asistencia ejecuta una sola autoridad cliente para teselas y fallback cartográfico', () => {
  assert.doesNotMatch(loaderSource, /attendance-admin-runtime-core\.js/);
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

test('un mapa de intento fallido puede reintentar el fondo sin recargar toda la página', () => {
  assert.match(reliabilitySource, /function retryManagedBaseLayer\(map\)/);
  assert.match(reliabilitySource, /state\.exhausted = true/);
  assert.match(reliabilitySource, /state\.attempted\.clear\(\)/);
  assert.match(reliabilitySource, /\[data-failure-map-details\]/);
  assert.match(reliabilitySource, /\.attendance-map, \.failure-attempt-map/);
  assert.match(reliabilitySource, /window\.addEventListener\('online', refreshAllMaps/);
  assert.match(reliabilitySource, /Cierra y vuelve a abrir el mapa o recupera la conexión para reintentar/);
});

test('retirar la autoridad duplicada conserva los otros módulos administrativos', () => {
  assert.match(loaderSource, /lorren-dialog\.js/);
  assert.match(loaderSource, /attendance-admin-compact\.js/);
  assert.match(loaderSource, /attendance-admin-manual-workday\.js/);
  assert.match(loaderSource, /attendance-admin-clear-marks\.js/);
  assert.match(loaderSource, /attendance-admin-billing-counter\.js/);
});
