import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeCityKey, dedupeCitiesByNormalizedName } from '../src/services/cityOptions.js';
import { normalizeTransportMode } from '../src/services/transportMode.js';

test('city options are deduplicated ignoring accents and case', () => {
  assert.equal(normalizeCityKey('Bogotá'), normalizeCityKey('bogota'));
  assert.deepEqual(
    dedupeCitiesByNormalizedName([
      { id: '1', name: 'Bogotá' },
      { id: '2', name: 'bogota' },
      { id: '3', name: 'Buenaventura' }
    ]).map((city) => city.name),
    ['Bogotá', 'Buenaventura']
  );
});

test('urban transport variants are normalized as Público', () => {
  assert.equal(normalizeTransportMode('Didi Por El Momento'), 'Público');
  assert.equal(normalizeTransportMode('transporte urbano'), 'Público');
  assert.equal(normalizeTransportMode('taxi'), 'Público');
  assert.equal(normalizeTransportMode('uber'), 'Público');
});

test('dispatch sync contracts keep operational data derived from candidates updated', () => {
  const dispatchBridge = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const publicDispatchClient = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const cityOptions = fs.readFileSync('src/services/cityOptions.js', 'utf8');
  const syncMigration = fs.readFileSync('prisma/migrations/20260521174000_sync_dispatch_worker_from_candidate/migration.sql', 'utf8');
  const cityBackfillMigration = fs.readFileSync('prisma/migrations/20260521175000_backfill_dispatch_worker_cities_from_candidates/migration.sql', 'utf8');

  assert.match(dispatchBridge, /loadUnifiedCityOptions/);
  assert.match(dispatchBridge, /resolveEquivalentCityIds/);
  assert.doesNotMatch(dispatchBridge, /where:\s*\{\s*usedForDispatch:\s*true\s*\}/);

  assert.match(publicDispatchClient, /loadUnifiedCityOptions/);
  assert.match(publicDispatchClient, /resolveEquivalentCityIds/);
  assert.doesNotMatch(publicDispatchClient, /where:\s*\{\s*usedForDispatch:\s*true\s*\}/);

  assert.match(cityOptions, /normalizeCityKey/);
  assert.match(cityOptions, /dedupeCitiesByNormalizedName/);

  assert.match(syncMigration, /CREATE TRIGGER trg_sync_dispatch_worker_from_candidate/);
  assert.match(syncMigration, /AFTER UPDATE OF/);
  assert.match(syncMigration, /"transportMode" = normalize_dispatch_transport_mode\(NEW\."transportMode"\)/);
  assert.match(syncMigration, /didi\|uber\|taxi\|transporte urbano/);

  assert.match(cityBackfillMigration, /INSERT INTO "DispatchWorkerCity"/);
  assert.match(cityBackfillMigration, /normalize_city_key/);
  assert.match(cityBackfillMigration, /ON CONFLICT \("workerId", "cityId"\) DO NOTHING/);
});
