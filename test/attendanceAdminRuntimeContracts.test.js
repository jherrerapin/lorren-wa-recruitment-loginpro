import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  filterAttendanceAdminHtml,
  filterAttendanceFeatureHtml
} from '../src/routes/dispatchBridge.js';

const runtimeSource = fs.readFileSync(
  new URL('../src/public/attendance-admin-runtime.js', import.meta.url),
  'utf8'
);

const leafletHtml = `<!doctype html><html><body><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-invalid" crossorigin=""></script></body></html>`;

test('el runtime correctivo se carga solamente en el panel administrativo de asistencia', () => {
  const adminHtml = filterAttendanceAdminHtml(leafletHtml);
  assert.match(adminHtml, /\/public\/attendance-admin-runtime\.js/);
  assert.equal((adminHtml.match(/attendance-admin-runtime\.js/g) || []).length, 1);

  const pointConfigHtml = filterAttendanceFeatureHtml(leafletHtml, { allowed: true });
  assert.doesNotMatch(pointConfigHtml, /attendance-admin-runtime\.js/);
});

test('las señales internas se presentan en español y el puntaje deja de parecer probabilidad', () => {
  assert.match(runtimeSource, /Marcación guardada sin conexión/);
  assert.match(runtimeSource, /Hora del celular no verificable/);
  assert.match(runtimeSource, /Sincronización tardía/);
  assert.match(runtimeSource, /Puntaje de revisión:/);
  assert.match(runtimeSource, /No representa una probabilidad de fraude/);
  assert.doesNotMatch(runtimeSource, /riskScore\s*[+\-]=/);
});

test('el mapa administrativo usa OSM primero y conserva IDECA como respaldo', () => {
  const osmIndex = runtimeSource.indexOf("label: 'OpenStreetMap'");
  const idecaIndex = runtimeSource.indexOf("label: 'Mapa oficial IDECA · UAECD'");
  assert.ok(osmIndex >= 0);
  assert.ok(idecaIndex > osmIndex);
  assert.match(runtimeSource, /TILE_TIMEOUT_MS = 5_000/);
  assert.match(runtimeSource, /tileerror/);
  assert.match(runtimeSource, /activateProvider\(map, state, index \+ 1\)/);
});

test('el mapa recalcula tamaño, centro y zoom al abrir tarjetas y geocerca', () => {
  assert.match(runtimeSource, /map\.invalidateSize/);
  assert.match(runtimeSource, /map\.setView/);
  assert.match(runtimeSource, /\[data-map-details\], \[data-attendance-card\]/);
  assert.match(runtimeSource, /\[0, 80, 260, 700\]/);
});
