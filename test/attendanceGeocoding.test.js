import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttendanceGeocodingQueries,
  geocodeAttendanceAddress,
  normalizeAttendanceGeocodingResults
} from '../src/services/attendanceGeocoding.js';

test('genera variantes exacta, normalizada y por intersección para una dirección colombiana', () => {
  const queries = buildAttendanceGeocodingQueries('Calle 25 Sur #51F-35, Bogotá, Colombia');
  assert.equal(queries[0], 'Calle 25 Sur #51F-35, Bogotá, Colombia');
  assert.ok(queries.includes('Calle 25 Sur, Carrera 51F, Bogotá, Colombia'));
  assert.ok(queries.includes('Calle 25 Sur 51F 35, Bogotá, Colombia'));
});

test('descarta resultados sin coordenadas válidas y limita la respuesta pública', () => {
  const results = normalizeAttendanceGeocodingResults([
    { lat: '4.611', lon: '-74.102', display_name: 'Bogotá, Colombia', importance: '0.7' },
    { lat: 'not-a-number', lon: '-74.2', display_name: 'Inválido' }
  ]);
  assert.deepEqual(results, [{
    lat: '4.611',
    lon: '-74.102',
    display_name: 'Bogotá, Colombia',
    type: null,
    importance: 0.7
  }]);
});

test('usa el servidor como cliente identificado y aplica fallback por intersección', async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return { ok: true, async json() { return []; } };
    return {
      ok: true,
      async json() {
        return [{
          lat: '4.60123',
          lon: '-74.11234',
          display_name: 'Calle 25 Sur con Carrera 51F, Bogotá, Colombia',
          type: 'intersection'
        }];
      }
    };
  };

  const results = await geocodeAttendanceAddress(
    'Calle 25 Sur #51F-35, Bogotá, Colombia prueba-636',
    {
      fetchFn,
      origin: 'https://lorren.example',
      nowFn: () => 1_000,
      sleepFn: async () => {}
    }
  );

  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /Calle\+25\+Sur%2C\+Carrera\+51F/);
  assert.match(requests[0].options.headers['User-Agent'], /Lorren-Attendance\/1\.0/);
  assert.equal(requests[0].options.headers.Referer, 'https://lorren.example/admin/operaciones');
  assert.equal(results[0].lat, '4.60123');
  assert.equal(results[0].lon, '-74.11234');
});
