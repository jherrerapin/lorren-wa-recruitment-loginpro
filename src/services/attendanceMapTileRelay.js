const OSM_TILE_ORIGIN = 'https://tile.openstreetmap.org';
const TILE_FETCH_TIMEOUT_MS = 7_000;
const TILE_FALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TILE_CACHE_MAX_ENTRIES = 256;
const TILE_MAX_BYTES = 1024 * 1024;
const TILE_USER_AGENT = 'LorrenAttendanceMap/1.0 (+https://github.com/jherrerapin/lorren-wa-recruitment-loginpro)';

const tileCache = new Map();
const inFlightTiles = new Map();

function integerTileCoordinate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function resolveAttendanceMapTileCoordinates(input = {}) {
  const z = integerTileCoordinate(input.z);
  const x = integerTileCoordinate(input.x);
  const y = integerTileCoordinate(input.y);
  if (z === null || x === null || y === null || z < 0 || z > 19) {
    throw new Error('attendance_map_tile_coordinates_invalid');
  }
  const limit = 2 ** z;
  if (x < 0 || y < 0 || x >= limit || y >= limit) {
    throw new Error('attendance_map_tile_coordinates_invalid');
  }
  return { z, x, y };
}

function safeReferer(value) {
  const referer = String(value || '').trim();
  if (!referer || referer.length > 700 || /[\r\n]/.test(referer)) return null;
  try {
    const url = new URL(referer);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function cacheTtlMs(headers, nowMs) {
  const cacheControl = String(headers?.get?.('cache-control') || '');
  const maxAge = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (maxAge) {
    const seconds = Number(maxAge[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  const expiresAt = Date.parse(String(headers?.get?.('expires') || ''));
  if (Number.isFinite(expiresAt) && expiresAt > nowMs) return expiresAt - nowMs;
  return TILE_FALLBACK_TTL_MS;
}

function pruneTileCache(nowMs) {
  for (const [key, entry] of tileCache) {
    if (entry.expiresAt <= nowMs) tileCache.delete(key);
  }
  while (tileCache.size >= TILE_CACHE_MAX_ENTRIES) {
    const oldestKey = tileCache.keys().next().value;
    if (oldestKey === undefined) break;
    tileCache.delete(oldestKey);
  }
}

function cachedTile(key, nowMs) {
  const entry = tileCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs) {
    tileCache.delete(key);
    return null;
  }
  tileCache.delete(key);
  tileCache.set(key, entry);
  return { ...entry, cacheStatus: 'HIT' };
}

async function fetchTileUpstream({ coordinates, referer, fetchImpl, nowMs }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TILE_FETCH_TIMEOUT_MS);
  const headers = {
    Accept: 'image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5',
    'User-Agent': TILE_USER_AGENT
  };
  const normalizedReferer = safeReferer(referer);
  if (normalizedReferer) headers.Referer = normalizedReferer;

  try {
    const url = `${OSM_TILE_ORIGIN}/${coordinates.z}/${coordinates.x}/${coordinates.y}.png`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response?.ok) throw new Error(`attendance_map_tile_upstream_${response?.status || 'failed'}`);

    const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) throw new Error('attendance_map_tile_content_type_invalid');
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length || body.length > TILE_MAX_BYTES) throw new Error('attendance_map_tile_size_invalid');

    const ttlMs = cacheTtlMs(response.headers, nowMs);
    return {
      body,
      contentType,
      cacheControl: `public, max-age=${Math.max(1, Math.floor(ttlMs / 1000))}`,
      etag: String(response.headers?.get?.('etag') || '').trim() || null,
      lastModified: String(response.headers?.get?.('last-modified') || '').trim() || null,
      expiresAt: nowMs + ttlMs,
      cacheStatus: 'MISS'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function loadAttendanceMapTile(input = {}, options = {}) {
  const coordinates = resolveAttendanceMapTileCoordinates(input);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('attendance_map_tile_fetch_unavailable');
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const key = `${coordinates.z}/${coordinates.x}/${coordinates.y}`;
  const hit = cachedTile(key, nowMs);
  if (hit) return hit;
  if (inFlightTiles.has(key)) return inFlightTiles.get(key);

  const request = (async () => {
    const tile = await fetchTileUpstream({
      coordinates,
      referer: options.referer,
      fetchImpl,
      nowMs
    });
    pruneTileCache(nowMs);
    tileCache.set(key, tile);
    return tile;
  })().finally(() => {
    inFlightTiles.delete(key);
  });

  inFlightTiles.set(key, request);
  return request;
}

export function clearAttendanceMapTileRelayCacheForTests() {
  tileCache.clear();
  inFlightTiles.clear();
}
