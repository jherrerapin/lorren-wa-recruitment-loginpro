import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttendanceGeocodingQueries,
  buildIdecaGeocodingQueries,
  geocodeAttendanceAddress,
  normalizeAttendanceGeocodingResults,
  normalizeBogotaAddressForIdeca,
  normalizeIdecaGeocodingResults
} from '../src/services/attendanceGeocoding.js';

test('genera variantes exacta, normalizada, por intersección y por vía principal', () => {
  const queries = buildAttendanceGeocodingQueries('Calle 25 Sur #51F-35, Bogotá, Colombia');
  assert.equal(queries[0], 'Calle 25 Sur #51F-35, Bogotá, Colombia');
  assert.ok(queries.includes('Calle 25 Sur, Carrera 51F, Bogotá, Colombia'));
  assert.ok(queries.includes('Calle 25 Sur con Carrera 51F, Bogotá, Colombia'));
  assert.ok(queries.includes('Calle 25 Sur 51F 35, Bogotá, Colombia'));
  assert.ok(queries.includes('Calle 25 Sur, Bogotá, Colombia'));
});

test('normaliza la nomenclatura bogotana al formato oficial de búsqueda', () => {
  assert.equal(
    normalizeBogotaAddressForIdeca('Calle 25 Sur #51F-35, Bogotá, Colombia'),
    'CL 25 SUR 51F 35'
  );
  assert.equal(
    normalizeBogotaAddressForIdeca('Avenida Carrera 30 #25-90, Bogotá'),
    'AK 30 25 90'
  );
  assert.deepEqual(
    buildIdecaGeocodingQueries('Calle 25 Sur #51F-35, Bogotá, Colombia'),
    ['CL 25 SUR 51F 35', 'Calle 25 Sur #51F-35', 'Calle 25 Sur 51F 35']
  );
  assert.deepEqual(buildIdecaGeocodingQueries('Carrera 5 #10-20, Cali'), []);
});

test('normaliza resultados Nominatim con proveedor y precisión explícitos', () => {
  const results = normalizeAttendanceGeocodingResults([
    { lat: '4.611', lon: '-74.102', display_name: 'Bogotá, Colombia', importance: '0.7' },
    { lat: 'not-a-number', lon: '-74.2', display_name: 'Inválido' }
  ], { provider: 'nominatim', precision: 'approximate' });

  assert.deepEqual(results, [{
    lat: '4.611',
    lon: '-74.102',
    display_name: 'Bogotá, Colombia',
    type: null,
    importance: 0.7,
    provider: 'nominatim',
    precision: 'approximate'
  }]);
});

test('extrae el centroide de la respuesta oficial de Mapas Bogotá', () => {
  const results = normalizeIdecaGeocodingResults({
    response: [{
      resultFields: ['NOMBRE', 'BARRIO'],
      urlService: 'https://serviciosgis.catastrobogota.gov.co/catastro/nomenclatura',
      data: [{
        NOMBRE: 'CL 25 SUR 51F 35',
        BARRIO: 'Muzú',
        centroide: { lat: 4.595123, lng: -74.132456 }
      }]
    }]
  }, 'Calle 25 Sur #51F-35, Bogotá, Colombia');

  assert.equal(results.length, 1);
  assert.equal(results[0].lat, '4.595123');
  assert.equal(results[0].lon, '-74.132456');
  assert.equal(results[0].provider, 'ideca');
  assert.equal(results[0].precision, 'address');
  assert.match(results[0].display_name, /CL 25 SUR 51F 35/);
});

test('consulta primero Mapas Bogotá para una dirección de Bogotá', async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          response: [{
            resultFields: ['EESDIRECCI'],
            urlService: 'https://serviciosgis.catastrobogota.gov.co/catastro/direcciones',
            data: [{
              EESDIRECCI: 'CL 25 SUR 51F 35',
              centroide: { lat: 4.595123, lng: -74.132456 }
            }]
          }]
        };
      }
    };
  };

  const results = await geocodeAttendanceAddress(
    'Calle 25 Sur #51F-35, Bogotá, Colombia prueba-ideca-638',
    { fetchFn, origin: 'https://lorren.example', nowFn: () => 1_000, sleepFn: async () => {} }
  );

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /catalogopmb\.catastrobogota\.gov\.co\/PMBWeb\/web\/buscar2/);
  assert.match(requests[0].url, /q=CL\+25\+SUR\+51F\+35/);
  assert.match(requests[0].options.headers['User-Agent'], /Lorren-Attendance\/1\.1/);
  assert.equal(results[0].provider, 'ideca');
  assert.equal(results[0].lat, '4.595123');
});

test('continúa con Nominatim cuando Mapas Bogotá no arroja coincidencias', async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('catalogopmb.catastrobogota.gov.co')) {
      return { ok: true, async json() { return { response: [] }; } };
    }
    return {
      ok: true,
      async json() {
        return [{
          lat: '4.60123',
          lon: '-74.11234',
          display_name: 'Calle 25 Sur, Bogotá, Colombia',
          type: 'residential',
          importance: 0.6
        }];
      }
    };
  };

  const results = await geocodeAttendanceAddress(
    'Calle 25 Sur #51F-36, Bogotá, Colombia prueba-fallback-638',
    { fetchFn, origin: 'https://lorren.example', nowFn: () => 2_000, sleepFn: async () => {} }
  );

  assert.ok(requests.some(({ url }) => url.includes('catalogopmb.catastrobogota.gov.co')));
  const nominatimRequest = requests.find(({ url }) => url.includes('nominatim.openstreetmap.org'));
  assert.ok(nominatimRequest);
  assert.match(nominatimRequest.url, /viewbox=/);
  assert.match(nominatimRequest.url, /bounded=1/);
  assert.match(nominatimRequest.options.headers['User-Agent'], /Lorren-Attendance\/1\.1/);
  assert.equal(results[0].provider, 'nominatim');
  assert.equal(results[0].lat, '4.60123');
});

test('continúa con Nominatim si Mapas Bogotá está temporalmente caído', async () => {
  const fetchFn = async (url) => {
    if (url.includes('catalogopmb.catastrobogota.gov.co')) {
      return { ok: false, status: 503, async json() { return {}; } };
    }
    return {
      ok: true,
      async json() {
        return [{ lat: '4.62', lon: '-74.10', display_name: 'Bogotá, Colombia' }];
      }
    };
  };

  const results = await geocodeAttendanceAddress(
    'Calle 26 #70-40, Bogotá, Colombia prueba-caida-638',
    { fetchFn, origin: 'https://lorren.example', nowFn: () => 3_000, sleepFn: async () => {} }
  );

  assert.equal(results[0].provider, 'nominatim');
  assert.equal(results[0].lat, '4.62');
});
