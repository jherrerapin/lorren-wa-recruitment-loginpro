const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const IDECA_SEARCH_URL = 'https://catalogopmb.catastrobogota.gov.co/PMBWeb/web/buscar2';
const NOMINATIM_MIN_INTERVAL_MS = 1_100;
const PROVIDER_TIMEOUT_MS = 8_000;
const GEOCODING_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const GEOCODING_CACHE_MAX_ENTRIES = 200;
const BOGOTA_VIEWBOX = '-74.267032,4.828575,-73.969597,4.514065';

const geocodingCache = new Map();
let nextNominatimRequestAt = 0;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripDiacritics(value) {
  return normalizeWhitespace(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function comparableText(value) {
  return stripDiacritics(value)
    .toUpperCase()
    .replace(/[^0-9A-Z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requireSearchQuery(value) {
  if (typeof value !== 'string') throw new Error('attendance_geocoding_query_required');
  const query = normalizeWhitespace(value);
  if (query.length < 4) throw new Error('attendance_geocoding_query_too_short');
  if (query.length > 180) throw new Error('attendance_geocoding_query_too_long');
  return query;
}

function uniqueQueries(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = normalizeWhitespace(value);
    if (!normalized) return false;
    const key = comparableText(normalized);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isBogotaQuery(query) {
  return /\bBOGOTA\b/.test(comparableText(query));
}

function withoutColombianAddressSymbols(query) {
  return normalizeWhitespace(
    query
      .replace(/\s*(?:#|n(?:o|ro|úm(?:ero)?)\.?|n°)\s*/giu, ' ')
      .replace(/([0-9A-Za-z])\s*-\s*([0-9A-Za-z])/g, '$1 $2')
  );
}

function crossStreetType(mainType) {
  const normalized = mainType.toLocaleLowerCase('es-CO');
  if (normalized.includes('calle') || normalized === 'diagonal') return 'Carrera';
  return 'Calle';
}

function colombianAddressParts(query) {
  const parts = query.split(',').map((part) => normalizeWhitespace(part)).filter(Boolean);
  const address = parts.shift() || '';
  const match = address.match(
    /^(Calle|Carrera|Diagonal|Transversal|Avenida\s+Calle|Avenida\s+Carrera)\s+([0-9]+[A-Za-z]?(?:\s+Bis)?(?:\s+(?:Sur|Norte|Este|Oeste))?)\s*(?:#|n(?:o|ro|úm(?:ero)?)\.?|n°)?\s*([0-9]+[A-Za-z]?(?:\s+Bis)?)\s*-\s*([0-9A-Za-z]+)$/iu
  );
  if (!match) return null;
  const [, mainType, mainNumber, crossNumber, accessNumber] = match;
  return { mainType, mainNumber, crossNumber, accessNumber, locationParts: parts };
}

function colombianIntersectionQuery(query, connector = ',') {
  const parsed = colombianAddressParts(query);
  if (!parsed) return null;
  const location = parsed.locationParts.length
    ? `, ${parsed.locationParts.join(', ')}`
    : ', Colombia';
  const crossStreet = `${crossStreetType(parsed.mainType)} ${parsed.crossNumber}`;
  return connector === 'con'
    ? `${parsed.mainType} ${parsed.mainNumber} con ${crossStreet}${location}`
    : `${parsed.mainType} ${parsed.mainNumber}, ${crossStreet}${location}`;
}

function colombianMainStreetQuery(query) {
  const parsed = colombianAddressParts(query);
  if (!parsed) return null;
  const location = parsed.locationParts.length
    ? `, ${parsed.locationParts.join(', ')}`
    : ', Colombia';
  return `${parsed.mainType} ${parsed.mainNumber}${location}`;
}

export function buildAttendanceGeocodingQueries(rawQuery) {
  const query = requireSearchQuery(rawQuery);
  return uniqueQueries([
    query,
    colombianIntersectionQuery(query),
    colombianIntersectionQuery(query, 'con'),
    withoutColombianAddressSymbols(query),
    colombianMainStreetQuery(query)
  ]);
}

function officialStreetType(value) {
  return comparableText(value)
    .replace(/^AVENIDA CARRERA\b/, 'AK')
    .replace(/^AVENIDA CALLE\b/, 'AC')
    .replace(/^AUTOPISTA\b/, 'AU')
    .replace(/^CARRERA\b/, 'KR')
    .replace(/^CALLE\b/, 'CL')
    .replace(/^DIAGONAL\b/, 'DG')
    .replace(/^TRANSVERSAL\b/, 'TV')
    .replace(/^AVENIDA\b/, 'AV');
}

export function normalizeBogotaAddressForIdeca(rawQuery) {
  const query = requireSearchQuery(rawQuery);
  const addressOnly = query.split(',')[0] || query;
  return officialStreetType(addressOnly)
    .replace(/\b(?:NUMERO|NUM|NO|NRO)\b/g, ' ')
    .replace(/[#\-–—.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildIdecaGeocodingQueries(rawQuery) {
  const query = requireSearchQuery(rawQuery);
  if (!isBogotaQuery(query)) return [];
  const addressOnly = normalizeWhitespace(query.split(',')[0] || query);
  return uniqueQueries([
    normalizeBogotaAddressForIdeca(query),
    addressOnly,
    withoutColombianAddressSymbols(addressOnly)
  ]);
}

function finiteCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizeResult({ latitude, longitude, displayName, type, importance, provider, precision }) {
  const lat = finiteCoordinate(latitude, -90, 90);
  const lon = finiteCoordinate(longitude, -180, 180);
  if (lat === null || lon === null) return null;
  return {
    lat: String(lat),
    lon: String(lon),
    display_name: normalizeWhitespace(displayName) || 'Ubicación encontrada',
    type: normalizeWhitespace(type) || null,
    importance: Number.isFinite(Number(importance)) ? Number(importance) : null,
    provider: normalizeWhitespace(provider) || 'unknown',
    precision: precision === 'address' ? 'address' : 'approximate'
  };
}

export function normalizeAttendanceGeocodingResults(payload, options = {}) {
  if (!Array.isArray(payload)) return [];
  const provider = options.provider || 'nominatim';
  const precision = options.precision || 'approximate';
  return payload
    .map((entry) => normalizeResult({
      latitude: entry?.lat,
      longitude: entry?.lon,
      displayName: entry?.display_name,
      type: entry?.type,
      importance: entry?.importance,
      provider,
      precision
    }))
    .filter(Boolean)
    .slice(0, 5);
}

function firstStringValue(entry, keys) {
  for (const key of keys) {
    const value = entry?.[key];
    if (typeof value === 'string' && normalizeWhitespace(value)) return normalizeWhitespace(value);
  }
  return null;
}

function genericIdecaLabel(entry, resultFields = []) {
  const preferredKeys = [
    'DIRECCION', 'Dirección', 'direccion', 'DIRECCI', 'EESDIRECCI',
    'NOMENCLATURA', 'NOMENCLA', 'PDONOMBRE', 'NOMBRE', 'nombre', 'VALUE',
    'BARRIO', 'barrio'
  ];
  const fromPreferred = firstStringValue(entry, preferredKeys);
  if (fromPreferred) return fromPreferred;

  const fromDeclaredFields = firstStringValue(entry, resultFields);
  if (fromDeclaredFields) return fromDeclaredFields;

  const dynamicKey = Object.keys(entry || {}).find((key) => (
    /direc|nomen|nombre|address|barrio|value/i.test(key)
    && typeof entry[key] === 'string'
    && normalizeWhitespace(entry[key])
  ));
  return dynamicKey ? normalizeWhitespace(entry[dynamicKey]) : 'Ubicación oficial de Bogotá';
}

function centroidFromGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const pointLat = finiteCoordinate(geometry.y ?? geometry.lat ?? geometry.latitude, -90, 90);
  const pointLon = finiteCoordinate(geometry.x ?? geometry.lng ?? geometry.lon ?? geometry.longitude, -180, 180);
  if (pointLat !== null && pointLon !== null) return { latitude: pointLat, longitude: pointLon };

  const ring = Array.isArray(geometry.rings?.[0]) ? geometry.rings[0] : null;
  if (!ring?.length) return null;
  const valid = ring
    .map((point) => ({
      longitude: finiteCoordinate(point?.[0], -180, 180),
      latitude: finiteCoordinate(point?.[1], -90, 90)
    }))
    .filter((point) => point.latitude !== null && point.longitude !== null);
  if (!valid.length) return null;
  return {
    latitude: valid.reduce((sum, point) => sum + point.latitude, 0) / valid.length,
    longitude: valid.reduce((sum, point) => sum + point.longitude, 0) / valid.length
  };
}

function idecaCoordinates(entry) {
  const centroide = entry?.centroide || entry?.CENTROIDE;
  const latitude = finiteCoordinate(centroide?.lat ?? centroide?.y, -90, 90);
  const longitude = finiteCoordinate(centroide?.lng ?? centroide?.lon ?? centroide?.x, -180, 180);
  if (latitude !== null && longitude !== null) return { latitude, longitude };
  return centroidFromGeometry(entry?.geometry || entry?.GEOMETRY || entry?.Geometry);
}

function tokenSet(value) {
  return new Set(comparableText(value).split(' ').filter((token) => token.length > 0));
}

function idecaMatchScore(rawQuery, label, sourceUrl) {
  const queryTokens = tokenSet(normalizeBogotaAddressForIdeca(rawQuery));
  const labelTokens = tokenSet(officialStreetType(label));
  if (!queryTokens.size || !labelTokens.size) return 0;
  let matches = 0;
  queryTokens.forEach((token) => {
    if (labelTokens.has(token)) matches += 1;
  });
  let score = matches / queryTokens.size;
  if (/placa|domicili|nomencl|direccion|catastro/i.test(sourceUrl || '')) score += 0.2;
  return Math.min(1, score);
}

export function normalizeIdecaGeocodingResults(payload, rawQuery) {
  const groups = Array.isArray(payload?.response)
    ? payload.response
    : (Array.isArray(payload?.resultados) ? [{ data: payload.resultados }] : []);
  const results = [];

  groups.forEach((group) => {
    const data = Array.isArray(group?.data) ? group.data : [];
    data.forEach((entry) => {
      const coordinates = idecaCoordinates(entry);
      if (!coordinates) return;
      const label = genericIdecaLabel(entry, Array.isArray(group?.resultFields) ? group.resultFields : []);
      const score = idecaMatchScore(rawQuery, label, group?.urlService);
      results.push(normalizeResult({
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        displayName: `${label}, Bogotá, Colombia`,
        type: 'official-address',
        importance: score,
        provider: 'ideca',
        precision: score >= 0.6 ? 'address' : 'approximate'
      }));
    });
  });

  return deduplicateResults(results.filter(Boolean))
    .sort((left, right) => (right.importance || 0) - (left.importance || 0))
    .slice(0, 5);
}

function deduplicateResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = `${Number(result.lat).toFixed(6)},${Number(result.lon).toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cacheKey(query) {
  return comparableText(query);
}

function readCache(query, now) {
  const key = cacheKey(query);
  const entry = geocodingCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    geocodingCache.delete(key);
    return null;
  }
  return entry.results;
}

function writeCache(query, results, now) {
  if (!results.length) return;
  if (geocodingCache.size >= GEOCODING_CACHE_MAX_ENTRIES) {
    const oldestKey = geocodingCache.keys().next().value;
    if (oldestKey) geocodingCache.delete(oldestKey);
  }
  geocodingCache.set(cacheKey(query), {
    results,
    expiresAt: now + GEOCODING_CACHE_TTL_MS
  });
}

async function reserveNominatimRequestSlot(nowFn, sleepFn) {
  const now = nowFn();
  const scheduledAt = Math.max(now, nextNominatimRequestAt);
  nextNominatimRequestAt = scheduledAt + NOMINATIM_MIN_INTERVAL_MS;
  const waitMs = scheduledAt - now;
  if (waitMs > 0) await sleepFn(waitMs);
}

function identifyingOrigin(value) {
  if (typeof value !== 'string') return 'https://lorren.app';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return 'https://lorren.app';
    return url.origin;
  } catch {
    return 'https://lorren.app';
  }
}

async function fetchJson(url, options, errorCode) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('attendance_geocoding_fetch_unavailable');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { ...options.requestOptions, signal: controller.signal });
    if (!response?.ok) throw new Error(errorCode);
    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestIdeca(query, rawQuery, options) {
  const params = new URLSearchParams({ q: query, page: '1', size: '20' });
  const payload = await fetchJson(`${IDECA_SEARCH_URL}?${params.toString()}`, {
    ...options,
    requestOptions: {
      headers: {
        Accept: 'application/json',
        'User-Agent': `Lorren-Attendance/1.1 (${identifyingOrigin(options.origin)})`
      }
    }
  }, 'attendance_geocoding_ideca_unavailable');
  return normalizeIdecaGeocodingResults(payload, rawQuery);
}

async function requestNominatim(query, options, precision = 'approximate') {
  const nowFn = options.nowFn || Date.now;
  const sleepFn = options.sleepFn || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const origin = identifyingOrigin(options.origin);
  await reserveNominatimRequestSlot(nowFn, sleepFn);

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '5',
    countrycodes: 'co',
    addressdetails: '1',
    dedupe: '1',
    'accept-language': 'es'
  });
  if (isBogotaQuery(query)) {
    params.set('viewbox', BOGOTA_VIEWBOX);
    params.set('bounded', '1');
  }

  const payload = await fetchJson(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
    ...options,
    requestOptions: {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'es',
        Referer: `${origin}/admin/operaciones`,
        'User-Agent': `Lorren-Attendance/1.1 (${origin})`
      }
    }
  }, 'attendance_geocoding_nominatim_unavailable');
  return normalizeAttendanceGeocodingResults(payload, { provider: 'nominatim', precision });
}

export async function geocodeAttendanceAddress(rawQuery, options = {}) {
  const query = requireSearchQuery(rawQuery);
  const nowFn = options.nowFn || Date.now;
  const cached = readCache(query, nowFn());
  if (cached) return cached;

  const providerErrors = [];
  const idecaQueries = buildIdecaGeocodingQueries(query);
  for (const idecaQuery of idecaQueries) {
    try {
      const results = await requestIdeca(idecaQuery, query, options);
      if (results.length) {
        writeCache(query, results, nowFn());
        return results;
      }
    } catch (error) {
      providerErrors.push(error);
      break;
    }
  }

  const nominatimQueries = buildAttendanceGeocodingQueries(query);
  for (let index = 0; index < nominatimQueries.length; index += 1) {
    try {
      const results = await requestNominatim(
        nominatimQueries[index],
        options,
        index === 0 ? 'address' : 'approximate'
      );
      if (results.length) {
        const deduplicated = deduplicateResults(results);
        writeCache(query, deduplicated, nowFn());
        return deduplicated;
      }
    } catch (error) {
      providerErrors.push(error);
      break;
    }
  }

  if (providerErrors.length >= 2) throw providerErrors.at(-1);
  return [];
}
