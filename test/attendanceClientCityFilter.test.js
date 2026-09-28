import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyAttendanceCityFilter,
  attendanceCitiesForRows
} from '../src/modules/dispatch-attendance/application/attendanceBoardCityFilter.js';

const routeSource = fs.readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
const exportSource = fs.readFileSync(new URL('../src/routes/attendanceFilteredExport.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../src/public/attendance-admin-client-city-filter.js', import.meta.url), 'utf8');
const runtimeSource = fs.readFileSync(new URL('../src/public/attendance-admin-runtime.js', import.meta.url), 'utf8');

test('las sucursales de Asistencia se derivan únicamente de las operaciones visibles del cliente', () => {
  const rows = [
    { id: '1', clientName: 'Cliente Uno', cityName: 'Bogotá' },
    { id: '2', clientName: 'Cliente Uno', cityName: 'Neiva' },
    { id: '3', clientName: 'Cliente Uno', cityName: 'Bogotá' }
  ];

  assert.deepEqual(attendanceCitiesForRows(rows), ['Bogotá', 'Neiva']);
});

test('el filtro de sucursal conserva una selección válida aunque el resultado actual quede vacío', () => {
  const board = {
    filters: { client: 'Cliente Uno', status: 'REVIEW_REQUIRED' },
    rows: [{ id: '1', clientName: 'Cliente Uno', cityName: 'Bogotá' }]
  };

  const filtered = applyAttendanceCityFilter(board, 'Neiva');
  assert.equal(filtered.filters.city, 'Neiva');
  assert.deepEqual(filtered.rows, []);
  assert.deepEqual(filtered.cities, ['Bogotá']);
});

test('el filtro de sucursal limita las filas sin alterar los demás filtros', () => {
  const board = {
    filters: { client: 'Cliente Uno', status: 'ALL', q: '' },
    rows: [
      { id: '1', clientName: 'Cliente Uno', cityName: 'Bogotá' },
      { id: '2', clientName: 'Cliente Uno', cityName: 'Neiva' }
    ]
  };

  const filtered = applyAttendanceCityFilter(board, 'Neiva');
  assert.equal(filtered.filters.client, 'Cliente Uno');
  assert.equal(filtered.filters.city, 'Neiva');
  assert.deepEqual(filtered.rows.map((row) => row.id), ['2']);
});

test('el backend expone sucursales dependientes del cliente y preserva city en acciones administrativas', () => {
  assert.match(routeSource, /SAFE_FILTER_KEYS = Object\.freeze\(\['from', 'to', 'status', 'client', 'city', 'q'\]\)/);
  assert.match(routeSource, /router\.get\('\/filter-options'/);
  assert.match(routeSource, /attendanceCitiesForRows\(board\.rows\)/);
  assert.match(routeSource, /applyAttendanceCityFilter\(baseBoard, req\.query\?\.city\)/);
  assert.match(routeSource, /city: safeHtmlAttributeState\(board\?\.filters\?\.city, 'ALL'\)/);
});

test('la interfaz carga sucursales al cambiar cliente y conserva el filtro en formularios POST', () => {
  assert.match(runtimeSource, /attendance-admin-client-city-filter\.js/);
  assert.match(uiSource, /label\.textContent = 'Sucursal'/);
  assert.match(uiSource, /select\.name = 'city'/);
  assert.match(uiSource, /clientSelect\.addEventListener\('change', \(\) => loadCities\('ALL'\)\)/);
  assert.match(uiSource, /\/filter-options\?/);
  assert.match(uiSource, /input\.dataset\.attendanceCityFilter = 'true'/);
  assert.match(uiSource, /input\.value = city \|\| 'ALL'/);
});

test('la descarga filtrada reutiliza la misma autoridad de sucursal', () => {
  assert.match(exportSource, /applyAttendanceCityFilter/);
  assert.match(exportSource, /const board = applyAttendanceCityFilter\(baseBoard, req\.query\?\.city\)/);
});
