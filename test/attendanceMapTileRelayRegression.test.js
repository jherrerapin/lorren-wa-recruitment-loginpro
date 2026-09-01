import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  clearAttendanceMapTileRelayCacheForTests,
  loadAttendanceMapTile,
  resolveAttendanceMapTileCoordinates
} from '../src/services/attendanceMapTileRelay.js';

const relaySource = fs.readFileSync(
  new URL('../src/services/attendanceMapTileRelay.js', import.meta.url),
  'utf8'
);
const routeSource = fs.readFileSync(
  new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url),
  'utf8'
);
const reliabilitySource = fs.readFileSync(
  new URL('../src/public/attendance-map-reliability.js', import.meta.url),
  'utf8'
);
const bridgeSource = fs.readFileSync(
  new URL('../src/routes/dispatchBridge.js', import.meta.url),
  'utf8'
);

function headers(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    get(name) {
      return normalized[String(name || '').toLowerCase()] ?? null;
    }
  };
}

function imageResponse({ body = [137, 80, 78, 71], responseHeaders = {} } = {}) {
  return {
    ok: true,
    status: 200,
    headers: headers({
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400',
      ...responseHeaders
    }),
    async arrayBuffer() {
      return Uint8Array.from(body).buffer;
    }
  };
}

test('el relay solo acepta coordenadas de tesela OSM válidas', () => {
  assert.deepEqual(
    resolveAttendanceMapTileCoordinates({ z: '4', x: '8', y: '6' }),
    { z: 4, x: 8, y: 6 }
  );
  for (const input of [
    { z: '-1', x: '0', y: '0' },
    { z: '20', x: '0', y: '0' },
    { z: '4', x: '16', y: '0' },
    { z: '4', x: '0', y: '16' },
    { z: '4', x: '1/2', y: '3' },
    { z: 'x', x: '1', y: '1' }
  ]) {
    assert.throws(
      () => resolveAttendanceMapTileCoordinates(input),
      /attendance_map_tile_coordinates_invalid/
    );
  }
  assert.doesNotMatch(relaySource, /input\.url|query\.url|new URL\(input/);
});

test('el relay identifica Lórren, conserva referer y reutiliza la tesela cacheada', async () => {
  clearAttendanceMapTileRelayCacheForTests();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return imageResponse({ responseHeaders: { etag: '"test-tile"' } });
  };

  const first = await loadAttendanceMapTile(
    { z: '4', x: '8', y: '6' },
    {
      fetchImpl,
      referer: 'https://example.test/admin/operaciones/asistencia',
      nowMs: 10_000
    }
  );
  const second = await loadAttendanceMapTile(
    { z: 4, x: 8, y: 6 },
    { fetchImpl, nowMs: 20_000 }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://tile.openstreetmap.org/4/8/6.png');
  assert.match(calls[0].options.headers['User-Agent'], /^LorrenAttendanceMap\//);
  assert.equal(
    calls[0].options.headers.Referer,
    'https://example.test/admin/operaciones/asistencia'
  );
  assert.equal(calls[0].options.headers['Cache-Control'], undefined);
  assert.equal(calls[0].options.headers.Pragma, undefined);
  assert.equal(first.cacheStatus, 'MISS');
  assert.equal(second.cacheStatus, 'HIT');
  assert.equal(first.cacheControl, 'public, max-age=86400');
  assert.equal(first.etag, '"test-tile"');
  assert.deepEqual([...first.body], [137, 80, 78, 71]);
});

test('el relay respeta no-store y no reutiliza esa respuesta', async () => {
  clearAttendanceMapTileRelayCacheForTests();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return imageResponse({ responseHeaders: { 'cache-control': 'no-store' } });
  };
  const first = await loadAttendanceMapTile(
    { z: 3, x: 2, y: 2 },
    { fetchImpl, nowMs: 30_000 }
  );
  const second = await loadAttendanceMapTile(
    { z: 3, x: 2, y: 2 },
    { fetchImpl, nowMs: 31_000 }
  );
  assert.equal(first.cacheControl, 'public, max-age=0');
  assert.equal(second.cacheControl, 'public, max-age=0');
  assert.equal(calls, 2);
});

test('el relay rechaza respuestas que no sean imágenes', async () => {
  clearAttendanceMapTileRelayCacheForTests();
  await assert.rejects(
    loadAttendanceMapTile(
      { z: 1, x: 0, y: 0 },
      {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: headers({ 'content-type': 'text/html' }),
          async arrayBuffer() { return Uint8Array.from([1]).buffer; }
        })
      }
    ),
    /attendance_map_tile_content_type_invalid/
  );
});

test('Asistencia mantiene una sola autoridad cliente y usa el relay como último fallback', () => {
  assert.match(
    bridgeSource,
    /router\.use\(\s*['"]\/asistencia['"]\s*,\s*requireOps\s*,\s*requireAttendanceAccess\s*,\s*dispatchAttendanceAdminRouter\(prisma\)/s
  );
  assert.match(routeSource, /router\.get\('\/map-tiles\/:z\/:x\/:y\.png'/);
  assert.match(routeSource, /loadAttendanceMapTile\(req\.params/);
  assert.match(
    reliabilitySource,
    /SAME_ORIGIN_TILE_URL = '\/admin\/operaciones\/asistencia\/map-tiles\/\{z\}\/\{x\}\/\{y\}\.png'/
  );
  assert.match(reliabilitySource, /return \['osm', 'relay'\]/);
  assert.match(reliabilitySource, /return \['osm', 'ideca', 'relay'\]/);
  assert.match(reliabilitySource, /relay:\s*\{[\s\S]*OpenStreetMap vía Lórren/);
  assert.match(reliabilitySource, /leaflet\.tileLayer = function reliableAttendanceTileLayer/);
});
