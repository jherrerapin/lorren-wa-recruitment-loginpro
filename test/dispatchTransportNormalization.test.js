import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeTransportMode, uniqueNormalizedTransportModes } from '../src/services/transportMode.js';

test('normalizeTransportMode groups public transport variants as Público', () => {
  assert.equal(normalizeTransportMode('bus'), 'Público');
  assert.equal(normalizeTransportMode('Buseta'), 'Público');
  assert.equal(normalizeTransportMode('TransMilenio'), 'Público');
  assert.equal(normalizeTransportMode('transmi'), 'Público');
  assert.equal(normalizeTransportMode('SITP'), 'Público');
  assert.equal(normalizeTransportMode('colectivo'), 'Público');
  assert.equal(normalizeTransportMode('transporte público'), 'Público');
  assert.equal(normalizeTransportMode('publico'), 'Público');
});

test('uniqueNormalizedTransportModes deduplicates old transport values', () => {
  assert.deepEqual(
    uniqueNormalizedTransportModes(['bus', 'TransMilenio', 'Público', 'sitp', 'Moto', 'moto']),
    ['Moto', 'Público']
  );
});

test('dispatch transport contracts use normalized values in routes and migration', () => {
  const dispatchBridge = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const publicDispatchClient = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const workerSync = fs.readFileSync('src/services/dispatchWorkerSync.js', 'utf8');
  const manualWorkerView = fs.readFileSync('src/views/operacionesPersonalNuevo.ejs', 'utf8');
  const migration = fs.readFileSync('prisma/migrations/20260521163000_normalize_dispatch_worker_transport/migration.sql', 'utf8');

  assert.match(dispatchBridge, /normalizeTransportMode/);
  assert.match(dispatchBridge, /uniqueNormalizedTransportModes/);
  assert.match(dispatchBridge, /transportWhere/);
  assert.match(dispatchBridge, /transportModes: uniqueNormalizedTransportModes/);

  assert.match(publicDispatchClient, /normalizeTransportMode/);
  assert.match(workerSync, /normalizeTransportMode\(candidate\.transportMode\)/);

  assert.match(manualWorkerView, /<select id="transportMode" name="transportMode">/);
  assert.match(manualWorkerView, /Bus, TransMilenio, SITP y colectivo se agrupan como Público/);

  assert.match(migration, /FROM "DispatchWorker"/);
  assert.match(migration, /transmilenio/);
  assert.match(migration, /colectivo/);
  assert.match(migration, /THEN 'Público'/);
});
