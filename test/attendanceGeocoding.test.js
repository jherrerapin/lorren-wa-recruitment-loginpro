import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttendanceGeocodingQueries,
  buildBogotaPlateQuery,
  buildIdecaGeocodingQueries,
  geocodeAttendanceAddress,
  normalizeArcgisGeocodingResults,
  normalizeAttendanceGeocodingResults,
  normalizeBogotaAddressForIdeca,
  normalizeBogotaPlateResults,
  normalizeIdecaGeocodingResults,
  resetAttendanceGeocodingStateForTests
} from '../src/services/attendanceGeocoding.js';

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return payload; } };
}

test.beforeEach(() => resetAttendanceGeocodingStateForTests());

test('genera variantes exacta, normalizada, por intersección y por vía principal', () => {
  const queries = buildAttendanceGeocodingQueries('Calle 25 Sur #51F-35, Bogotá, Colombia');
  assert.equal(queries[0], 'Calle 25 Sur #51F-35, Bogotá, Colombia');
  assert.ok(queries.includes('Calle 25 Sur, Carrera 51F, Bogotá, Colombia'));
  assert.ok(queries.includes('Calle 25 Sur con Carrera 51F, Bogotá, Colombia'));
  assert.ok(queries.includes('Calle 25 Sur 51F 35, Bogotá, Colombia'));
  assert.ok(queries.includes('Calle 25 Sur, Bogotá, Colombia'));
});

test('normaliza nomenclatura bogotana y construye consulta segura de placa domiciliaria', () => {
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
  const plateQuery = buildBogotaPlateQuery('Calle 25 Sur #51F-35, Bogotá, Colombia');
  assert.equal(plateQuery.exact, 'CL 25 SUR 51F 35');
  assert.equal(plateQuery.prefix, 'CL 25 SUR 51F');
  assert.match(plateQuery.where, /PDONVIAL = 'CL 25 SUR 51F 35'/);
  assert.match(plateQuery.where, /PDONVIAL LIKE 'CL 25 SUR 51F %'/);
  assert.equal(buildBogotaPlateQuery('Carrera 5 #10-20, Cali'), null);
});

test('normaliza resultados de Nominatim con proveedor y precisión explícitos', () => {
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

test('normaliza la capa oficial de placa domiciliaria como resultado exacto', () => {
  const results = normalizeBogotaPlateResults({
    features: [{
      attributes: { PDONVIAL: 'CL 25 SUR 51F 35', PDOTEXTO: '35', PDOTIPO: 1 },
      geometry: { x: -74.132456, y: 4.595123 }
    }]
  }, 'Calle 25 Sur #51F-35, Bogotá, Colombia');

  assert.equal(results.length, 1);
  assert.equal(results[0].provider, 'ideca-placa');
  assert.equal(results[0].precision, 'address');
  assert.equal(results[0].importance, 1);
  assert.equal(results[0].lat, '4.595123');
  assert.equal(results[0].lon, '-74.132456');
});

test('conserva el buscador legado de Mapas Bogotá como respaldo', () => {
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

  assert.equal(results[0].provider, 'ideca-legacy');
  assert.equal(results[0].precision, 'address');
});

test('normaliza candidatos de ArcGIS sin exponer el token', () => {
  const results = normalizeArcgisGeocodingResults({
    candidates: [{
      address: 'Calle 25 Sur 51F 35, Bogotá',
      score: 96,
      location: { x: -74.1324, y: 4.5951 },
      attributes: { Addr_type: 'PointAddress' }
    }]
  });
  assert.equal(results[0].provider, 'arcgis');
  assert.equal(results[0].precision, 'address');
  assert.equal(results[0].importance, 0.96);
});

test('consulta primero la capa oficial de placas y detiene la cascada al hallar coincidencia exacta', async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    return response({
      features: [{
        attributes: { PDONVIAL: 'CL 25 SUR 51F 35' },
        geometry: { x: -74.132456, y: 4.595123 }
      }]
    });
  };

  const results = await geocodeAttendanceAddress(
    'Calle 25 Sur #51F-35, Bogotá, Colombia',
    {
      fetchFn,
      origin: 'https://lorren.example',
      nowFn: () => 1_000,
      sleepFn: async () => {},
      disableCache: true
    }
  );

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /catastro\/placadomiciliaria\/MapServer\/0\/query/);
  assert.match(requests[0].url, /outSR=4326/);
  assert.match(requests[0].options.headers['User-Agent'], /Lorren-Attendance\/2\.0/);
  assert.equal(results[0].provider, 'ideca-placa');
});

test('usa ArcGIS del lado del servidor cuando hay token y la capa oficial no coincide', async () => {
  const requests = [];
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('placadomiciliaria')) return response({ features: [] });
    if (url.includes('geocode-api.arcgis.com')) {
      return response({
        candidates: [{
          address: 'Calle 25 Sur 51F 35, Bogotá',
          score: 95,
          location: { x: -74.13245, y: 4.59512 },
          attributes: { Addr_type: 'PointAddress' }
        }]
      });
    }
    throw new Error(`solicitud inesperada: ${url}`);
  };

  const results = await geocodeAttendanceAddress(
    'Calle 25 Sur #51F-35, Bogotá, Colombia',
    {
      fetchFn,
      arcgisToken: 'test-token-not-exposed',
      origin: 'https://lorren.example',
      nowFn: () => 2_000,
      sleepFn: async () => {},
      disableCache: true
    }
  );

  const arcgis = requests.find(({ url }) => url.includes('geocode-api.arcgis.com'));
  assert.ok(arcgis);
  assert.doesNotMatch(arcgis.url, /test-token-not-exposed/);
  assert.equal(arcgis.options.headers['X-Esri-Authorization'], 'Bearer test-token-not-exposed');
  assert.equal(results[0].provider, 'arcgis');
});

test('continúa por legado y Nominatim cuando la capa oficial está temporalmente caída', async () => {
  const requests = [];
  const fetchFn = async (url) => {
    requests.push(url);
    if (url.includes('placadomiciliaria')) return response({}, { ok: false, status: 503 });
    if (url.includes('catalogopmb.catastrobogota.gov.co')) return response({ response: [] });
    if (url.includes('nominatim.openstreetmap.org')) {
      return response([{
        lat: '4.60123',
        lon: '-74.11234',
        display_name: 'Calle 25 Sur, Bogotá, Colombia',
        type: 'residential',
        importance: 0.6
      }]);
    }
    throw new Error(`solicitud inesperada: ${url}`);
  };

  const results = await geocodeAttendanceAddress(
    'Calle 25 Sur #51F-36, Bogotá, Colombia',
    {
      fetchFn,
      origin: 'https://lorren.example',
      nowFn: () => 3_000,
      sleepFn: async () => {},
      disableCache: true
    }
  );

  assert.equal(requests.filter((url) => url.includes('placadomiciliaria')).length, 2);
  assert.ok(requests.some((url) => url.includes('catalogopmb.catastrobogota.gov.co')));
  const nominatimRequest = requests.find((url) => url.includes('nominatim.openstreetmap.org'));
  assert.ok(nominatimRequest);
  assert.match(nominatimRequest, /viewbox=/);
  assert.match(nominatimRequest, /bounded=1/);
  assert.equal(results[0].provider, 'nominatim');
});

test('no almacena búsquedas vacías y vuelve a consultar en el siguiente intento', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    if (url.includes('placadomiciliaria')) return response({ features: [] });
    if (url.includes('catalogopmb')) return response({ response: [] });
    return response([]);
  };
  const options = {
    fetchFn,
    origin: 'https://lorren.example',
    nowFn: () => 4_000,
    sleepFn: async () => {}
  };

  await geocodeAttendanceAddress('Calle 31 #10-99, Bogotá, Colombia', options);
  const firstCalls = calls;
  await geocodeAttendanceAddress('Calle 31 #10-99, Bogotá, Colombia', options);
  assert.ok(calls > firstCalls);
});
