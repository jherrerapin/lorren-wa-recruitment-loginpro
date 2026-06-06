import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GeocodingProvider,
  geocodeResidence,
  normalizeGoogleGeocodeResult,
  normalizeNominatimResult,
  pickBestGeocodingCandidate
} from '../src/services/geocodingProvider.js';

test('geocoding queda deshabilitado por defecto', async () => {
  const result = await geocodeResidence('Patio Bonito', { provider: 'disabled' });

  assert.equal(result.status, 'disabled');
  assert.equal(result.reason, 'provider_disabled');
  assert.deepEqual(result.candidates, []);
});

test('normaliza resultado de Google Geocoding a contrato comun', () => {
  const normalized = normalizeGoogleGeocodeResult({
    formatted_address: 'Patio Bonito, Kennedy, Bogotá, Colombia',
    place_id: 'place-123',
    geometry: { location: { lat: 4.63, lng: -74.16 }, location_type: 'ROOFTOP' },
    address_components: [
      { long_name: 'Patio Bonito', types: ['neighborhood'] },
      { long_name: 'Kennedy', types: ['sublocality_level_1'] },
      { long_name: 'Bogotá', types: ['locality'] }
    ]
  });

  assert.equal(normalized.provider, GeocodingProvider.GOOGLE);
  assert.equal(normalized.displayName, 'Patio Bonito, Kennedy, Bogotá, Colombia');
  assert.equal(normalized.placeId, 'place-123');
  assert.equal(normalized.city, 'Bogotá');
  assert.equal(normalized.locality, 'Kennedy');
  assert.equal(normalized.neighborhood, 'Patio Bonito');
  assert.equal(normalized.confidence, 0.94);
});

test('normaliza resultado de Nominatim a contrato comun', () => {
  const normalized = normalizeNominatimResult({
    display_name: 'Patio Bonito, Kennedy, Bogotá, Colombia',
    place_id: 456,
    lat: '4.63',
    lon: '-74.16',
    importance: 0.82,
    address: {
      city: 'Bogotá',
      suburb: 'Kennedy',
      neighbourhood: 'Patio Bonito'
    }
  });

  assert.equal(normalized.provider, GeocodingProvider.NOMINATIM);
  assert.equal(normalized.placeId, '456');
  assert.equal(normalized.city, 'Bogotá');
  assert.equal(normalized.locality, 'Kennedy');
  assert.equal(normalized.neighborhood, 'Patio Bonito');
  assert.equal(normalized.latitude, 4.63);
  assert.equal(normalized.longitude, -74.16);
});

test('Google provider usa cliente inyectado y restringe busqueda a Colombia', async () => {
  const calls = [];
  const httpClient = {
    get: async (url, options) => {
      calls.push({ url, options });
      return { data: { results: [] } };
    }
  };

  const result = await geocodeResidence('Patio Bonito', {
    provider: 'google',
    apiKey: 'fake-key',
    httpClient
  });

  assert.equal(result.status, 'ok');
  assert.equal(calls[0].url, 'https://maps.googleapis.com/maps/api/geocode/json');
  assert.equal(calls[0].options.params.region, 'co');
  assert.equal(calls[0].options.params.components, 'country:CO');
});

test('Nominatim provider exige user agent y restringe busqueda a Colombia', async () => {
  const calls = [];
  const httpClient = {
    get: async (url, options) => {
      calls.push({ url, options });
      return { data: [] };
    }
  };

  const result = await geocodeResidence('Patio Bonito', {
    provider: 'nominatim',
    userAgent: 'lorren-test/1.0 contact@example.com',
    httpClient
  });

  assert.equal(result.status, 'ok');
  assert.equal(calls[0].url, 'https://nominatim.openstreetmap.org/search');
  assert.equal(calls[0].options.params.countrycodes, 'co');
  assert.equal(calls[0].options.headers['User-Agent'], 'lorren-test/1.0 contact@example.com');
});

test('selecciona mejor candidato por confianza', () => {
  const best = pickBestGeocodingCandidate([
    { displayName: 'A', confidence: 0.6 },
    { displayName: 'B', confidence: 0.9 },
    { displayName: 'C', confidence: 0.7 }
  ]);

  assert.equal(best.displayName, 'B');
});
