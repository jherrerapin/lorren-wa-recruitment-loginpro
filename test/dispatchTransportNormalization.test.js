import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeBogotaLocalidad } from '../src/services/geographyNormalization.js';
import { normalizeTransportMode, uniqueNormalizedTransportModes } from '../src/services/transportMode.js';
import { alignCandidateLocationFields, normalizeCandidateFields } from '../src/services/candidateData.js';

test('normalizeBogotaLocalidad resuelve localidades desde aliases seguros', () => {
  assert.equal(normalizeBogotaLocalidad('Suba Lisboa'), 'Suba');
  assert.equal(normalizeBogotaLocalidad('Lisboa'), 'Suba');
  assert.equal(normalizeBogotaLocalidad('Suba Bilbao'), 'Suba');
  assert.equal(normalizeBogotaLocalidad('Bilbao'), 'Suba');
  assert.equal(normalizeBogotaLocalidad('Kennedy Patio Bonito'), 'Kennedy');
  assert.equal(normalizeBogotaLocalidad('Patio Bonito'), 'Kennedy');
  assert.equal(normalizeBogotaLocalidad('Ciudad Bolívar'), 'Ciudad Bolívar');
  assert.equal(normalizeBogotaLocalidad('Hola'), null);
});

test('alineacion de residencia aplica localidad de Bogota solo con vacante Bogota', () => {
  assert.deepEqual(
    alignCandidateLocationFields({ neighborhood: 'Suba Lisboa' }, { city: 'Bogotá' }),
    { neighborhood: null, locality: 'Suba' }
  );
  assert.deepEqual(
    alignCandidateLocationFields({ neighborhood: 'Suba Lisboa' }, { city: 'Ibagué' }),
    { neighborhood: 'Suba Lisboa', locality: null }
  );
  assert.deepEqual(
    alignCandidateLocationFields({ locality: 'Estoy interesado' }, { city: 'Bogotá' }),
    { locality: null, neighborhood: null }
  );
});

test('normalizeTransportMode guarda solo valores finales normalizados', () => {
  assert.equal(normalizeTransportMode('No tengo transporte'), 'Publico');
  assert.equal(normalizeTransportMode('No tengo medio de transporte'), 'Publico');
  assert.equal(normalizeTransportMode('Bus'), 'Publico');
  assert.equal(normalizeTransportMode('Transmilenio'), 'Publico');
  assert.equal(normalizeTransportMode('Transmi'), 'Publico');
  assert.equal(normalizeTransportMode('SITP'), 'Publico');
  assert.equal(normalizeTransportMode('Uber'), 'Publico');
  assert.equal(normalizeTransportMode('A pie'), 'Publico');
  assert.equal(normalizeTransportMode('Moto'), 'Moto');
  assert.equal(normalizeTransportMode('Carro'), 'Carro');
  assert.equal(normalizeTransportMode('Bicicleta'), 'Bicicleta');
  assert.equal(normalizeTransportMode('Patineta eléctrica'), 'Patineta eléctrica');
  assert.equal(normalizeTransportMode('Hola'), null);
  assert.equal(normalizeTransportMode('Estoy interesado'), null);
});

test('normalizeCandidateFields no conserva texto basura como transporte', () => {
  assert.equal(normalizeCandidateFields({ transportMode: 'Transmilenio' }).transportMode, 'Publico');
  assert.equal(normalizeCandidateFields({ transportMode: 'Patineta eléctrica' }).transportMode, 'Patineta eléctrica');
  assert.equal(normalizeCandidateFields({ transportMode: 'Estoy interesado' }).transportMode, undefined);
  assert.equal(normalizeBogotaLocalidad('  ciudad   bolivar  '), 'Ciudad Bolívar');
});

test('uniqueNormalizedTransportModes deduplicates old transport values', () => {
  assert.deepEqual(
    uniqueNormalizedTransportModes(['bus', 'TransMilenio', 'Publico', 'sitp', 'Moto', 'moto']),
    ['Moto', 'Publico']
  );
});

test('dispatch transport contracts use normalized values and operational eligibility in routes', () => {
  const dispatchBridge = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const publicDispatchClient = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const workerSync = fs.readFileSync('src/services/dispatchWorkerSync.js', 'utf8');
  const manualWorkerView = fs.readFileSync('src/views/operacionesPersonalNuevo.ejs', 'utf8');
  const migration = fs.readFileSync('prisma/migrations/20260521163000_normalize_dispatch_worker_transport/migration.sql', 'utf8');

  assert.match(dispatchBridge, /normalizeTransportMode/);
  assert.match(dispatchBridge, /uniqueNormalizedTransportModes/);
  assert.match(dispatchBridge, /transportWhere/);
  assert.match(dispatchBridge, /transportModes: uniqueNormalizedTransportModes/);
  assert.match(dispatchBridge, /buildDispatchEligibilityFilter/);
  assert.match(dispatchBridge, /gender:\s*\{\s*not:\s*'FEMALE'\s*\}/);
  assert.match(dispatchBridge, /vacancyId:\s*\{\s*not:\s*null\s*\}/);

  assert.match(publicDispatchClient, /normalizeTransportMode/);
  assert.match(workerSync, /normalizeTransportMode\(candidate\.transportMode\)/);

  assert.match(manualWorkerView, /<select id="transportMode" name="transportMode">/);
  assert.match(manualWorkerView, /Bus, TransMilenio, SITP y colectivo se agrupan como Publico/);

  assert.match(migration, /FROM "DispatchWorker"/);
  assert.match(migration, /transmilenio/);
  assert.match(migration, /colectivo/);
  assert.match(migration, /THEN 'Publico'/);
});
