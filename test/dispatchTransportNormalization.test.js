import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeBogotaLocalidad, GeographyNormalizationService } from '../src/services/geographyNormalization.js';
import { normalizeTransportMode, uniqueNormalizedTransportModes, TransportNormalizationService } from '../src/services/transportMode.js';
import { alignCandidateLocationFields, normalizeCandidateFields } from '../src/services/candidateData.js';

test('GeographyNormalizationService normaliza localidades de Bogota desde aliases seguros', () => {
  const service = new GeographyNormalizationService();
  assert.equal(service.normalizeBogotaLocalidad('Suba Lisboa'), 'Suba');
  assert.equal(service.normalizeBogotaLocalidad('Lisboa'), 'Suba');
  assert.equal(service.normalizeBogotaLocalidad('Suba Bilbao'), 'Suba');
  assert.equal(service.normalizeBogotaLocalidad('Bilbao'), 'Suba');
  assert.equal(service.normalizeBogotaLocalidad('Kennedy Patio Bonito'), 'Kennedy');
  assert.equal(service.normalizeBogotaLocalidad('Patio Bonito'), 'Kennedy');
  assert.equal(service.normalizeBogotaLocalidad('Ciudad Bolívar'), 'Ciudad Bolívar');
  assert.equal(service.normalizeBogotaLocalidad('Hola'), null);
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

test('TransportNormalizationService guarda solo valores finales normalizados', () => {
  const service = new TransportNormalizationService();
  assert.equal(service.normalize('No tengo transporte'), 'Publico');
  assert.equal(service.normalize('No tengo medio de transporte'), 'Publico');
  assert.equal(service.normalize('Bus'), 'Publico');
  assert.equal(service.normalize('Transmilenio'), 'Publico');
  assert.equal(service.normalize('Transmi'), 'Publico');
  assert.equal(service.normalize('SITP'), 'Publico');
  assert.equal(service.normalize('Uber'), 'Publico');
  assert.equal(service.normalize('A pie'), 'Publico');
  assert.equal(service.normalize('Moto'), 'Moto');
  assert.equal(service.normalize('Carro'), 'Carro');
  assert.equal(service.normalize('Bicicleta'), 'Bicicleta');
  assert.equal(service.normalize('Patineta eléctrica'), 'Patineta eléctrica');
  assert.equal(service.normalize('Hola'), null);
  assert.equal(service.normalize('Estoy interesado'), null);
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
