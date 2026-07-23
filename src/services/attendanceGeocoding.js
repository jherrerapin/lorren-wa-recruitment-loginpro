const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_MIN_INTERVAL_MS = 1_100;
const NOMINATIM_TIMEOUT_MS = 8_000;
const GEOCODING_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const GEOCODING_CACHE_MAX_ENTRIES = 200;

const geocodingCache = new Map();
let nextNominatimRequestAt = 0;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
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
    const key = normalized.toLocaleLowerCase('es-CO');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function colombianIntersectionQuery(query) {
  const parts = query.split(',').map((part) => normalizeWhitespace(part)).filter(Boolean);
  const address = parts.shift() || '';
  const match = address.match(
    /^(Calle|Carrera|Diagonal|Transversal|Avenida\s+Calle|Avenida\s+Carrera)\s+([0-9]+[A-Za-z]?(?:\s+Bis)?(?:\s+(?:Sur|Norte|Este|Oeste))?)\s*(?:#|n(?:o|ro|úm(?:ero)?)\.?|n°)?\s*([0-9]+[A-Za-z]?(?:\s+Bis)?)\s*-\s*[0-9A-Za-z]+$/iu
  );
  if (!match) return null;

  const [, mainType, mainNumber, crossNumber] = match;
  const location = parts.length ? `, ${parts.join(', ')}` : ', Colombia';
  return `${mainType} ${mainNumber}, ${crossStreetType(mainType)} ${crossNumber}${location}`;
}

export function buildAttendanceGeocodingQueries(rawQuery) {
  const query = requireSearchQuery(rawQuery);
  return uniqueQueries([
    query,
    colombianIntersectionQuery(query),
    withoutColombianAddressSymbols(query)
  ]);
}

function finiteCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

export function normalizeAttendanceGeocodingResults(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((entry) => {
      const latitude = finiteCoordinate(entry?.lat, -90, 90);
      const longitude = finiteCoordinate(entry?.lon, -180, 180);
      if (latitude === null || longitude === null) return null;
      return {
        lat: String(latitude),
        lon: String(longitude),
        display_name: normalizeWhitespace(entry?.display_name) || 'Ubicación encontrada',
        type: normalizeWhitespace(entry?.type) || null,
        importance: Number.isFinite(Number(entry?.importance)) ? Number(entry.importance) : null
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function cacheKey(query) {
  return query.toLocaleLowerCase('es-CO');
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

async function requestNominatim(query, options) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('attendance_geocoding_fetch_unavailable');
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);

  try {
    const response = await fetchFn(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'es',
        Referer: `${origin}/admin/operaciones`,
        'User-Agent': `Lorren-Attendance/1.0 (${origin})`
      },
      signal: controller.signal
    });
    if (!response?.ok) throw new Error('attendance_geocoding_provider_unavailable');
    return normalizeAttendanceGeocodingResults(await response.json());
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function geocodeAttendanceAddress(rawQuery, options = {}) {
  const queries = buildAttendanceGeocodingQueries(rawQuery);
  const nowFn = options.nowFn || Date.now;
  const now = nowFn();
  const cached = readCache(queries[0], now);
  if (cached) return cached;

  let lastError = null;
  for (const query of queries) {
    try {
      const results = await requestNominatim(query, { ...options, nowFn });
      if (results.length) {
        writeCache(queries[0], results, nowFn());
        return results;
      }
    } catch (error) {
      lastError = error;
      break;
    }
  }

  if (lastError) throw lastError;
  writeCache(queries[0], [], nowFn());
  return [];
}
