import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  geocodeAttendanceAddress,
  resetAttendanceGeocodingStateForTests
} from '../src/services/attendanceGeocoding.js';

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
const pointViewSource = fs.readFileSync(
  new URL('../src/views/operacionesClienteOperaciones.ejs', import.meta.url),
  'utf8'
);
const geocoderSource = fs.readFileSync(
  new URL('../src/services/attendanceGeocoding.js', import.meta.url),
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

test('el punto operativo usa el SRI correcto y reanuda un mapa abierto tras cargar Leaflet', () => {
  const leafletIntegrity = /sha256-20nQCchB9co0qIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo=/;
  assert.match(bridgeSource, leafletIntegrity);
  assert.match(pointViewSource, leafletIntegrity);
  assert.doesNotMatch(bridgeSource, /20nQCchB9coqIjJZRGuk2/);
  assert.doesNotMatch(pointViewSource, /20nQCchB9coqIjJZRGuk2/);
  assert.match(pointViewSource, /\/public\/attendance-map-reliability\.js/);
  assert.match(pointViewSource, /lorren:attendance-map-ready/);
  assert.match(runtimeSource, /new CustomEvent\('lorren:attendance-map-ready'\)/);
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

test('usa dos fondos independientes en Bogotá y cambia también cuando una tesela queda colgada', () => {
  assert.match(runtimeSource, /tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
  assert.match(runtimeSource, /Mapa_Referencia\/mapa_base_3857\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}/);
  assert.match(runtimeSource, /\['ideca', 'osm'\]/);
  assert.match(runtimeSource, /tileerror/);
  assert.match(runtimeSource, /TILE_LOAD_TIMEOUT_MS = 4_500/);
  assert.match(runtimeSource, /no respondió a tiempo/);
  assert.match(runtimeSource, /activateProvider\(map, nextProvider\)/);
  assert.match(runtimeSource, /Fondo cartográfico activo/);
  assert.match(runtimeSource, /El mapa sigue aceptando clics y las coordenadas siguen siendo válidas/);
});

test('la búsqueda agrega contexto, acepta Enter y exige selección explícita', () => {
  assert.match(runtimeSource, /inferCityFromSearchInput/);
  assert.match(runtimeSource, /contextualSearchQuery/);
  assert.match(runtimeSource, /params\.set\('city', city\)/);
  assert.match(runtimeSource, /GEOCODING_REQUEST_TIMEOUT_MS = 8_000/);
  assert.match(runtimeSource, /event\.key !== 'Enter'/);
  assert.match(runtimeSource, /Confirma el resultado correcto/);
  assert.match(runtimeSource, /nunca guardará el primer resultado sin confirmación/);
  assert.match(runtimeSource, /data-attendance-geocode-results/);
  assert.doesNotMatch(runtimeSource, /results\s*\[\s*0\s*\]/);
  assert.doesNotMatch(runtimeSource, /fetch\(`https:\/\/nominatim/);
  assert.match(pointViewSource, /data-attendance-search-city/);
  assert.doesNotMatch(pointViewSource, /nominatim\.openstreetmap\.org\/search/);
  assert.doesNotMatch(pointViewSource, /reserveNominatimSearchSlot/);
  assert.match(bridgeSource, /city: normalizeString\(req\.query\?\.city\)/);
});

test('la geocodificación tiene presupuesto total y no reintenta un proveedor colgado', async () => {
  resetAttendanceGeocodingStateForTests();
  let calls = 0;
  const hangingFetch = async (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    calls += 1;
    const abort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });

  const startedAt = Date.now();
  await assert.rejects(
    geocodeAttendanceAddress('CL 25 SUR 51F 36', {
      city: 'Bogotá',
      fetchFn: hangingFetch,
      origin: 'https://lorren.example',
      timeoutMs: 20,
      totalBudgetMs: 70,
      disableCache: true,
      sleepFn: async () => {}
    }),
    /_timeout|budget_exhausted/
  );
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 500, `la búsqueda colgada tardó ${elapsedMs} ms`);
  assert.ok(calls < 8, `se hicieron ${calls} llamadas pese al presupuesto`);
  assert.match(geocoderSource, /GEOCODING_TOTAL_BUDGET_MS = 6_500/);
  assert.match(geocoderSource, /Promise\.all\(fallbackTasks\)/);
  assert.match(geocoderSource, /_timeout`, \{ retryable: false \}/);
  resetAttendanceGeocodingStateForTests();
});

test('usar mi ubicación conserva varias lecturas y selecciona la de mejor precisión', () => {
  assert.match(runtimeSource, /navigator\.geolocation\.watchPosition/);
  assert.match(runtimeSource, /accuracy < Number\(bestPosition\.coords\.accuracy\)/);
  assert.match(runtimeSource, /TARGET_ACCURACY_METERS = 20/);
  assert.match(runtimeSource, /navigator\.geolocation\.clearWatch/);
});

test('el runtime cartográfico no depende de diálogos nativos para recuperarse', () => {
  assert.doesNotMatch(runtimeSource, /window\.prompt/);
  assert.doesNotMatch(pointViewSource, /window\.prompt/);
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
