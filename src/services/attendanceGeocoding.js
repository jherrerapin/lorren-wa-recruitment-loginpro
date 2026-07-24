const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const IDECA_LEGACY_SEARCH_URL = 'https://catalogopmb.catastrobogota.gov.co/PMBWeb/web/buscar2';
const IDECA_PLATE_QUERY_URL = 'https://serviciosgis.catastrobogota.gov.co/arcgis/rest/services/catastro/placadomiciliaria/MapServer/0/query';
const ARCGIS_GEOCODING_URL = 'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
const NOMINATIM_MIN_INTERVAL_MS = 1_100;
const PROVIDER_TIMEOUT_MS = 7_000;
const PROVIDER_RETRY_DELAY_MS = 180;
const PROVIDER_MAX_ATTEMPTS = 2;
const PROVIDER_FAILURE_THRESHOLD = 2;
const PROVIDER_CIRCUIT_COOLDOWN_MS = 60_000;
const GEOCODING_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const GEOCODING_CACHE_MAX_ENTRIES = 300;
const BOGOTA_VIEWBOX = '-74.267032,4.828575,-73.969597,4.514065';
const MAX_PUBLIC_RESULTS = 5;

const geocodingCache = new Map();
const providerHealth = new Map();
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
  if (query.length < 3) throw new Error('attendance_geocoding_query_too_short');
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

function containsWholeComparable(source, fragment) {
  const haystack = ` ${comparableText(source)} `;
  const needle = comparableText(fragment);
  return Boolean(needle && haystack.includes(` ${needle} `));
}

export function buildContextualAttendanceQuery(rawQuery, city) {
  const query = requireSearchQuery(rawQuery);
  const normalizedCity = normalizeWhitespace(city);
  const parts = [query];
  if (normalizedCity && !containsWholeComparable(query, normalizedCity)) parts.push(normalizedCity);
  if (!containsWholeComparable(query, 'Colombia')) parts.push('Colombia');
  const contextual = normalizeWhitespace(parts.join(', '));
  if (contextual.length > 180) return query;
  return contextual;
}

function isBogotaQuery(query) {
  return /\bBOGOTA\b/.test(comparableText(query));
}

function withoutColombianAddressSymbols(query) {
  return normalizeWhitespace(
    query
      .replace(/\s*(?:#|n(?:o|ro|úm(?:ero)?)\.?|n°)\s*/giu, ' ')
      .replace(/([0-9A-Za-z])\s*[-–—]\s*([0-9A-Za-z])/g, '$1 $2')
  );
}

const STREET_TYPE_PATTERN = [
  'Avenida\\s+Carrera', 'Avenida\\s+Calle', 'Autopista', 'Transversal', 'Diagonal',
  'Carrera', 'Calle', 'Avenida', 'AK', 'AC', 'AU', 'KR', 'CRA', 'CR', 'CLL', 'CL', 'DG', 'TV', 'AV'
].join('|');
const STREET_NUMBER_PATTERN = '[0-9]+[A-Za-z]?(?:\\s+Bis)?(?:\\s+(?:Sur|Norte|Este|Oeste))?';
const COLOMBIAN_ADDRESS_PATTERN = new RegExp(
  `^(${STREET_TYPE_PATTERN})\\s+(${STREET_NUMBER_PATTERN})\\s*(?:#|n(?:o|ro|úm(?:ero)?)\\.?|n°)?\\s*(${STREET_NUMBER_PATTERN})\\s*(?:[-–—]|\\s+)\\s*([0-9A-Za-z]+)(?:\\b|$)`,
  'iu'
);

function canonicalStreetType(value) {
  const type = comparableText(value);
  const map = {
    AK: 'Avenida Carrera',
    AC: 'Avenida Calle',
    AU: 'Autopista',
    KR: 'Carrera',
    CRA: 'Carrera',
    CR: 'Carrera',
    CARRERA: 'Carrera',
    CL: 'Calle',
    CLL: 'Calle',
    CALLE: 'Calle',
    DG: 'Diagonal',
    DIAGONAL: 'Diagonal',
    TV: 'Transversal',
    TRANSVERSAL: 'Transversal',
    AV: 'Avenida',
    AVENIDA: 'Avenida',
    'AVENIDA CARRERA': 'Avenida Carrera',
    'AVENIDA CALLE': 'Avenida Calle',
    AUTOPISTA: 'Autopista'
  };
  return map[type] || normalizeWhitespace(value);
}

function splitAddressLocation(query) {
  const parts = query.split(',').map((part) => normalizeWhitespace(part)).filter(Boolean);
  return { address: parts.shift() || '', locationParts: parts };
}

function colombianAddressParts(query) {
  const { address, locationParts } = splitAddressLocation(query);
  const match = address.match(COLOMBIAN_ADDRESS_PATTERN);
  if (!match) return null;
  const [, rawMainType, mainNumber, crossNumber, accessNumber] = match;
  return {
    mainType: canonicalStreetType(rawMainType),
    mainNumber: normalizeWhitespace(mainNumber),
    crossNumber: normalizeWhitespace(crossNumber),
    accessNumber: normalizeWhitespace(accessNumber),
    locationParts
  };
}

function crossStreetType(mainType) {
  const normalized = canonicalStreetType(mainType).toLocaleLowerCase('es-CO');
  if (normalized.includes('calle') || normalized === 'diagonal') return 'Carrera';
  return 'Calle';
}

function locationSuffix(parts) {
  return parts.length ? `, ${parts.join(', ')}` : ', Colombia';
}

function canonicalColombianAddressQuery(query) {
  const parsed = colombianAddressParts(query);
  if (!parsed) return null;
  return `${parsed.mainType} ${parsed.mainNumber} #${parsed.crossNumber}-${parsed.accessNumber}${locationSuffix(parsed.locationParts)}`;
}

function colombianIntersectionQuery(query, connector = ',') {
  const parsed = colombianAddressParts(query);
  if (!parsed) return null;
  const crossStreet = `${crossStreetType(parsed.mainType)} ${parsed.crossNumber}`;
  return connector === 'con'
    ? `${parsed.mainType} ${parsed.mainNumber} con ${crossStreet}${locationSuffix(parsed.locationParts)}`
    : `${parsed.mainType} ${parsed.mainNumber}, ${crossStreet}${locationSuffix(parsed.locationParts)}`;
}

function colombianMainStreetQuery(query) {
  const parsed = colombianAddressParts(query);
  if (!parsed) return null;
  return `${parsed.mainType} ${parsed.mainNumber}${locationSuffix(parsed.locationParts)}`;
}

export function buildAttendanceGeocodingQueries(rawQuery) {
  const query = requireSearchQuery(rawQuery);
  return uniqueQueries([
    query,
    canonicalColombianAddressQuery(query),
    colombianIntersectionQuery(query),
    colombianIntersectionQuery(query, 'con'),
    withoutColombianAddressSymbols(query),
    colombianMainStreetQuery(query)
  ]);
}

function officialStreetType(value) {
  const normalized = comparableText(value);
  const aliases = [
    ['AVENIDA CARRERA', 'AK'], ['AK', 'AK'],
    ['AVENIDA CALLE', 'AC'], ['AC', 'AC'],
    ['AUTOPISTA', 'AU'], ['AU', 'AU'],
    ['CARRERA', 'KR'], ['CRA', 'KR'], ['KR', 'KR'], ['CR', 'KR'],
    ['CALLE', 'CL'], ['CLL', 'CL'], ['CL', 'CL'],
    ['DIAGONAL', 'DG'], ['DG', 'DG'],
    ['TRANSVERSAL', 'TV'], ['TV', 'TV'],
    ['AVENIDA', 'AV'], ['AV', 'AV']
  ];
  for (const [prefix, replacement] of aliases) {
    if (normalized === prefix) return replacement;
    if (normalized.startsWith(`${prefix} `)) return `${replacement}${normalized.slice(prefix.length)}`;
  }
  return normalized;
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
  const canonical = canonicalColombianAddressQuery(query)?.split(',')[0] || null;
  return uniqueQueries([
    normalizeBogotaAddressForIdeca(query),
    canonical,
    addressOnly,
    withoutColombianAddressSymbols(addressOnly)
  ]);
}

function finiteCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizedImportance(value, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
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
    importance: normalizedImportance(importance, null),
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
    .slice(0, MAX_PUBLIC_RESULTS);
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
    'NOMENCLATURA', 'NOMENCLA', 'PDONVIAL', 'PDONOMBRE', 'NOMBRE', 'nombre',
    'VALUE', 'BARRIO', 'barrio'
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
  return new Set(comparableText(value).split(' ').filter(Boolean));
}

function tokenMatchScore(query, label) {
  const queryTokens = tokenSet(query);
  const labelTokens = tokenSet(label);
  if (!queryTokens.size || !labelTokens.size) return 0;
  let matches = 0;
  queryTokens.forEach((token) => {
    if (labelTokens.has(token)) matches += 1;
  });
  return matches / queryTokens.size;
}

function idecaMatchScore(rawQuery, label, sourceUrl) {
  let score = tokenMatchScore(normalizeBogotaAddressForIdeca(rawQuery), officialStreetType(label));
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
        provider: 'ideca-legacy',
        precision: score >= 0.72 ? 'address' : 'approximate'
      }));
    });
  });
  return sortAndDeduplicate(results.filter(Boolean));
}

function officialPlatePrefix(rawQuery) {
  const parsed = colombianAddressParts(rawQuery);
  if (!parsed) return null;
  const officialType = officialStreetType(parsed.mainType);
  return `${officialType} ${comparableText(parsed.mainNumber)} ${comparableText(parsed.crossNumber)}`.trim();
}

export function buildBogotaPlateQuery(rawQuery) {
  const query = requireSearchQuery(rawQuery);
  if (!isBogotaQuery(query)) return null;
  const exact = normalizeBogotaAddressForIdeca(query);
  const prefix = officialPlatePrefix(query);
  if (!prefix || !/^(?:CL|KR|AK|AC|DG|TV|AU|AV)\s/.test(exact)) return null;
  const safeExact = exact.replace(/'/g, "''");
  const safePrefix = prefix.replace(/'/g, "''");
  return {
    exact,
    prefix,
    where: `PDONVIAL = '${safeExact}' OR PDONVIAL LIKE '${safePrefix} %'`
  };
}

export function normalizeBogotaPlateResults(payload, rawQuery) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const expected = normalizeBogotaAddressForIdeca(rawQuery);
  return sortAndDeduplicate(features.map((feature) => {
    const attributes = feature?.attributes || {};
    const label = firstStringValue(attributes, ['PDONVIAL', 'PDoNvial', 'pdonvial']) || 'Placa domiciliaria';
    const coordinates = centroidFromGeometry(feature?.geometry);
    if (!coordinates) return null;
    const comparableLabel = comparableText(label);
    const score = comparableLabel === comparableText(expected)
      ? 1
      : Math.min(0.95, tokenMatchScore(expected, label));
    return normalizeResult({
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      displayName: `${label}, Bogotá, Colombia`,
      type: 'official-address-plate',
      importance: score,
      provider: 'ideca-placa',
      precision: score >= 0.82 ? 'address' : 'approximate'
    });
  }).filter(Boolean));
}

export function normalizeArcgisGeocodingResults(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  return sortAndDeduplicate(candidates.map((candidate) => {
    const score = normalizedImportance(Number(candidate?.score) / 100, 0);
    const addressType = normalizeWhitespace(candidate?.attributes?.Addr_type || candidate?.attributes?.Type || '');
    const addressPrecisionTypes = new Set([
      'PointAddress', 'Subaddress', 'StreetAddress', 'StreetInt', 'StreetMidBlock',
      'StreetBetween', 'DistanceMarker'
    ]);
    return normalizeResult({
      latitude: candidate?.location?.y,
      longitude: candidate?.location?.x,
      displayName: candidate?.address,
      type: addressType || 'arcgis-candidate',
      importance: score,
      provider: 'arcgis',
      precision: score >= 0.84 && addressPrecisionTypes.has(addressType) ? 'address' : 'approximate'
    });
  }).filter(Boolean));
}

function resultRank(result) {
  const precision = result.precision === 'address' ? 2 : 0;
  const provider = result.provider === 'ideca-placa' ? 0.35
    : result.provider === 'arcgis' ? 0.25
      : result.provider === 'ideca-legacy' ? 0.12 : 0;
  return precision + provider + (result.importance || 0);
}

function sortAndDeduplicate(results) {
  const sorted = results
    .filter(Boolean)
    .sort((left, right) => resultRank(right) - resultRank(left));
  const seen = new Set();
  return sorted.filter((result) => {
    const key = `${Number(result.lat).toFixed(6)},${Number(result.lon).toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_PUBLIC_RESULTS);
}

function hasStrongAddressResult(results) {
  return results.some((result) => result.precision === 'address' && (result.importance || 0) >= 0.9);
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

function providerError(code, { retryable = true } = {}) {
  const error = new Error(code);
  error.retryable = retryable;
  return error;
}

function providerState(name) {
  if (!providerHealth.has(name)) providerHealth.set(name, { failures: 0, openUntil: 0 });
  return providerHealth.get(name);
}

function providerIsAvailable(name, now) {
  return providerState(name).openUntil <= now;
}

function markProviderSuccess(name) {
  providerHealth.set(name, { failures: 0, openUntil: 0 });
}

function markProviderFailure(name, now) {
  const state = providerState(name);
  const failures = state.failures + 1;
  providerHealth.set(name, {
    failures,
    openUntil: failures >= PROVIDER_FAILURE_THRESHOLD ? now + PROVIDER_CIRCUIT_COOLDOWN_MS : 0
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
  if (typeof fetchFn !== 'function') throw providerError('attendance_geocoding_fetch_unavailable');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { ...options.requestOptions, signal: controller.signal });
    if (!response?.ok) {
      const status = Number(response?.status || 0);
      throw providerError(errorCode, { retryable: status === 0 || status === 429 || status >= 500 });
    }
    const payload = await response.json();
    if (payload?.error) {
      const status = Number(payload.error.code || 0);
      throw providerError(errorCode, { retryable: status === 429 || status >= 500 });
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw providerError(`${errorCode}_timeout`);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runProvider(name, requestFn, options) {
  const nowFn = options.nowFn || Date.now;
  const sleepFn = options.sleepFn || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (!providerIsAvailable(name, nowFn())) {
    throw providerError(`attendance_geocoding_${name}_circuit_open`, { retryable: false });
  }
  let lastError = null;
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const results = await requestFn();
      markProviderSuccess(name);
      return Array.isArray(results) ? results : [];
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt === PROVIDER_MAX_ATTEMPTS) break;
      await sleepFn(PROVIDER_RETRY_DELAY_MS * attempt);
    }
  }
  markProviderFailure(name, nowFn());
  throw lastError || providerError(`attendance_geocoding_${name}_unavailable`);
}

async function requestBogotaPlate(rawQuery, options) {
  const plateQuery = buildBogotaPlateQuery(rawQuery);
  if (!plateQuery) return [];
  const params = new URLSearchParams({
    where: plateQuery.where,
    outFields: 'PDONVIAL,PDOTEXTO,PDOTIPO,PDOCODIGO',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '20',
    f: 'json'
  });
  const payload = await fetchJson(`${IDECA_PLATE_QUERY_URL}?${params.toString()}`, {
    ...options,
    requestOptions: {
      headers: {
        Accept: 'application/json',
        'User-Agent': `Lorren-Attendance/2.1 (${identifyingOrigin(options.origin)})`
      }
    }
  }, 'attendance_geocoding_ideca_placa_unavailable');
  return normalizeBogotaPlateResults(payload, rawQuery);
}

async function requestArcgis(rawQuery, options) {
  const token = normalizeWhitespace(options.arcgisToken ?? process.env.ATTENDANCE_ARCGIS_GEOCODING_TOKEN);
  if (!token) return [];
  const params = new URLSearchParams({
    SingleLine: rawQuery,
    sourceCountry: 'COL',
    outFields: 'Match_addr,Addr_type,City,Country',
    outSR: '4326',
    maxLocations: '5',
    forStorage: 'false',
    f: 'json'
  });
  if (isBogotaQuery(rawQuery)) params.set('searchExtent', BOGOTA_VIEWBOX);
  const payload = await fetchJson(`${ARCGIS_GEOCODING_URL}?${params.toString()}`, {
    ...options,
    requestOptions: {
      headers: {
        Accept: 'application/json',
        'X-Esri-Authorization': `Bearer ${token}`
      }
    }
  }, 'attendance_geocoding_arcgis_unavailable');
  return normalizeArcgisGeocodingResults(payload);
}

async function requestIdecaLegacy(query, rawQuery, options) {
  const params = new URLSearchParams({ q: query, page: '1', size: '20' });
  const payload = await fetchJson(`${IDECA_LEGACY_SEARCH_URL}?${params.toString()}`, {
    ...options,
    requestOptions: {
      headers: {
        Accept: 'application/json',
        'User-Agent': `Lorren-Attendance/2.1 (${identifyingOrigin(options.origin)})`
      }
    }
  }, 'attendance_geocoding_ideca_legacy_unavailable');
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
        'User-Agent': `Lorren-Attendance/2.1 (${origin})`
      }
    }
  }, 'attendance_geocoding_nominatim_unavailable');
  return normalizeAttendanceGeocodingResults(payload, { provider: 'nominatim', precision });
}

function appendResults(target, incoming) {
  target.push(...(Array.isArray(incoming) ? incoming : []));
  return sortAndDeduplicate(target);
}

export async function geocodeAttendanceAddress(rawQuery, options = {}) {
  const query = buildContextualAttendanceQuery(rawQuery, options.city);
  const nowFn = options.nowFn || Date.now;
  const cached = options.disableCache ? null : readCache(query, nowFn());
  if (cached) return cached;

  const collected = [];
  const errors = [];
  let successfulProviders = 0;
  const useProvider = async (name, requestFn) => {
    try {
      const results = await runProvider(name, requestFn, options);
      successfulProviders += 1;
      appendResults(collected, results);
    } catch (error) {
      errors.push(error);
    }
  };

  if (isBogotaQuery(query) && buildBogotaPlateQuery(query)) {
    await useProvider('ideca_placa', () => requestBogotaPlate(query, options));
    if (hasStrongAddressResult(collected)) {
      const result = sortAndDeduplicate(collected);
      if (!options.disableCache) writeCache(query, result, nowFn());
      return result;
    }
  }

  const arcgisToken = normalizeWhitespace(options.arcgisToken ?? process.env.ATTENDANCE_ARCGIS_GEOCODING_TOKEN);
  if (arcgisToken) {
    await useProvider('arcgis', () => requestArcgis(query, options));
    if (hasStrongAddressResult(collected)) {
      const result = sortAndDeduplicate(collected);
      if (!options.disableCache) writeCache(query, result, nowFn());
      return result;
    }
  }

  if (isBogotaQuery(query)) {
    const idecaQueries = buildIdecaGeocodingQueries(query);
    for (const idecaQuery of idecaQueries.slice(0, 3)) {
      await useProvider('ideca_legacy', () => requestIdecaLegacy(idecaQuery, query, options));
      if (collected.length) break;
      if (!providerIsAvailable('ideca_legacy', nowFn())) break;
    }
  }

  if (!hasStrongAddressResult(collected)) {
    const nominatimQueries = buildAttendanceGeocodingQueries(query);
    for (let index = 0; index < Math.min(4, nominatimQueries.length); index += 1) {
      await useProvider('nominatim', () => requestNominatim(
        nominatimQueries[index],
        options,
        index <= 1 ? 'address' : 'approximate'
      ));
      if (hasStrongAddressResult(collected) || collected.length >= MAX_PUBLIC_RESULTS) break;
      if (!providerIsAvailable('nominatim', nowFn())) break;
    }
  }

  const results = sortAndDeduplicate(collected);
  if (results.length) {
    if (!options.disableCache) writeCache(query, results, nowFn());
    return results;
  }
  if (!successfulProviders && errors.length) throw errors.at(-1);
  return [];
}

export function resetAttendanceGeocodingStateForTests() {
  geocodingCache.clear();
  providerHealth.clear();
  nextNominatimRequestAt = 0;
}
