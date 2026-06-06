import axios from 'axios';

export const GeocodingProvider = Object.freeze({
  DISABLED: 'disabled',
  GOOGLE: 'google',
  NOMINATIM: 'nominatim'
});

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeProvider(value = process.env.GEOCODING_PROVIDER || '') {
  const provider = clean(value).toLowerCase();
  if (provider === GeocodingProvider.GOOGLE) return GeocodingProvider.GOOGLE;
  if (provider === GeocodingProvider.NOMINATIM) return GeocodingProvider.NOMINATIM;
  return GeocodingProvider.DISABLED;
}

function pickAddressComponent(components = [], types = []) {
  const wanted = new Set(types);
  const found = (components || []).find((component) => (component.types || []).some((type) => wanted.has(type)));
  return found?.long_name || null;
}

export function normalizeGoogleGeocodeResult(item = {}) {
  const components = item.address_components || [];
  const city = pickAddressComponent(components, ['locality', 'administrative_area_level_2']);
  const locality = pickAddressComponent(components, ['sublocality_level_1', 'sublocality']);
  const neighborhood = pickAddressComponent(components, ['neighborhood', 'sublocality_level_2']);

  return {
    provider: GeocodingProvider.GOOGLE,
    displayName: item.formatted_address || null,
    placeId: item.place_id || null,
    city,
    locality,
    neighborhood,
    latitude: item.geometry?.location?.lat ?? null,
    longitude: item.geometry?.location?.lng ?? null,
    confidence: item.geometry?.location_type === 'ROOFTOP' ? 0.94 : 0.86,
    raw: item
  };
}

export function normalizeNominatimResult(item = {}) {
  const address = item.address || {};
  const city = address.city || address.town || address.municipality || address.county || null;
  const locality = address.suburb || address.city_district || null;
  const neighborhood = address.neighbourhood || address.quarter || address.hamlet || null;

  return {
    provider: GeocodingProvider.NOMINATIM,
    displayName: item.display_name || null,
    placeId: item.place_id ? String(item.place_id) : null,
    city,
    locality,
    neighborhood,
    latitude: item.lat ? Number(item.lat) : null,
    longitude: item.lon ? Number(item.lon) : null,
    confidence: Number.isFinite(Number(item.importance)) ? Math.min(0.9, Math.max(0.55, Number(item.importance))) : 0.72,
    raw: item
  };
}

async function geocodeWithGoogle(query, { httpClient = axios, apiKey = process.env.GOOGLE_GEOCODING_API_KEY } = {}) {
  if (!apiKey) return { status: 'disabled', reason: 'missing_google_key', candidates: [] };
  const response = await httpClient.get('https://maps.googleapis.com/maps/api/geocode/json', {
    params: { address: query, key: apiKey, region: 'co', components: 'country:CO', language: 'es' },
    timeout: 8000
  });
  const results = Array.isArray(response.data?.results) ? response.data.results : [];
  return { status: 'ok', provider: GeocodingProvider.GOOGLE, candidates: results.map(normalizeGoogleGeocodeResult).filter((item) => item.displayName) };
}

async function geocodeWithNominatim(query, { httpClient = axios, userAgent = process.env.NOMINATIM_USER_AGENT } = {}) {
  if (!userAgent) return { status: 'disabled', reason: 'missing_nominatim_user_agent', candidates: [] };
  const response = await httpClient.get('https://nominatim.openstreetmap.org/search', {
    params: { q: query, format: 'jsonv2', addressdetails: 1, countrycodes: 'co', limit: 3 },
    headers: { 'User-Agent': userAgent },
    timeout: 8000
  });
  const results = Array.isArray(response.data) ? response.data : [];
  return { status: 'ok', provider: GeocodingProvider.NOMINATIM, candidates: results.map(normalizeNominatimResult).filter((item) => item.displayName) };
}

export async function geocodeResidence(query = '', options = {}) {
  const text = clean(query);
  if (!text) return { status: 'skipped', reason: 'empty_query', candidates: [] };

  const provider = normalizeProvider(options.provider);
  if (provider === GeocodingProvider.DISABLED) return { status: 'disabled', reason: 'provider_disabled', candidates: [] };
  if (provider === GeocodingProvider.GOOGLE) return geocodeWithGoogle(text, options);
  if (provider === GeocodingProvider.NOMINATIM) return geocodeWithNominatim(text, options);

  return { status: 'disabled', reason: 'unknown_provider', candidates: [] };
}

export function pickBestGeocodingCandidate(candidates = []) {
  return [...(candidates || [])]
    .filter((candidate) => candidate?.displayName)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;
}
