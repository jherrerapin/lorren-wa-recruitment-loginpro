import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeCityKey,
  dedupeCitiesByNormalizedName,
  projectOperationalBranchOptions
} from '../src/services/cityOptions.js';
import {
  applyAttendanceCityFilter,
  attendanceCitiesForRows
} from '../src/modules/dispatch-attendance/application/attendanceBoardCityFilter.js';
import { buildProgrammingReportHtml } from '../src/services/dispatchProgrammingPdfService.js';
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

test('Siberia se proyecta como parte de la sucursal Bogotá sin perder sus IDs históricos', () => {
  const projected = projectOperationalBranchOptions([
    { id: 'bogota-id', name: 'Bogotá' },
    { id: 'siberia-id', name: 'Siberia' },
    { id: 'cali-id', name: 'Cali' }
  ]);
  assert.deepEqual(projected.map((city) => city.name), ['Bogotá', 'Cali']);
  const bogota = projected.find((city) => city.name === 'Bogotá');
  assert.equal(bogota.id, 'bogota-id');
  assert.deepEqual(new Set(bogota.equivalentCityIds), new Set(['bogota-id', 'siberia-id']));
});

test('filtro de Asistencia muestra Bogotá una sola vez e incluye filas descriptivas de Siberia', () => {
  const board = {
    rows: [
      { id: 'bog', cityName: 'Bogotá' },
      { id: 'sib', cityName: 'Siberia' },
      { id: 'cal', cityName: 'Cali' }
    ]
  };
  assert.deepEqual(attendanceCitiesForRows(board.rows), ['Bogotá', 'Cali']);
  const filtered = applyAttendanceCityFilter(board, 'Bogotá');
  assert.deepEqual(filtered.rows.map((row) => row.id), ['bog', 'sib']);
});

test('PDF de programación agrupa Siberia bajo Bogotá pero conserva ciudad y dirección del servicio', () => {
  const request = {
    id: 'req-siberia',
    cityName: 'Siberia',
    clientName: 'Cliente',
    operationPointName: 'Operación Siberia',
    address: 'Dirección original Siberia',
    serviceName: 'Servicio',
    requiredWorkers: 0,
    startTime: '08:00',
    endTime: '17:00',
    assignments: []
  };
  const html = buildProgrammingReportHtml({
    selectedDate: '2026-10-01',
    requests: [request],
    managedBy: 'DEV',
    includePending: true,
    overallSummary: { totalRequests: 1, completedRequests: 0 },
    workerAbsences: [],
    includeWorkerAbsences: false
  });
  assert.match(html, /<h2>Bogotá<\/h2>/);
  assert.doesNotMatch(html, /<h2>Siberia<\/h2>/);
  assert.match(html, /<b>Ciudad:<\/b> Siberia/);
  assert.match(html, /<b>Dirección:<\/b> Dirección original Siberia/);
});

test('selectores operativos usan la autoridad consolidada de sucursales', () => {
  const assignments = fs.readFileSync('src/routes/dispatchAssignmentConfirmations.js', 'utf8');
  const locationsView = fs.readFileSync('src/views/locations.ejs', 'utf8');
  assert.match(assignments, /loadUnifiedCityOptions/);
  assert.match(assignments, /resolveEquivalentCityIds/);
  assert.doesNotMatch(assignments, /prisma\.city\.findMany\(\{ where: \{ usedForDispatch: true \}/);
  assert.match(locationsView, /const branchCities/);
  assert.match(locationsView, /name: 'Bogotá', operations: mergedBogotaOperations/);
});

test('urban transport variants are normalized as Publico', () => {
  assert.equal(normalizeTransportMode('Didi Por El Momento'), 'Publico');
  assert.equal(normalizeTransportMode('transporte urbano'), 'Publico');
  assert.equal(normalizeTransportMode('taxi'), 'Publico');
  assert.equal(normalizeTransportMode('uber'), 'Publico');
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
  assert.match(cityOptions, /projectOperationalBranchOptions/);

  assert.match(syncMigration, /CREATE TRIGGER trg_sync_dispatch_worker_from_candidate/);
  assert.match(syncMigration, /AFTER UPDATE OF/);
  assert.match(syncMigration, /"transportMode" = normalize_dispatch_transport_mode\(NEW\."transportMode"\)/);
  assert.match(syncMigration, /didi\|uber\|taxi\|transporte urbano/);

  assert.match(cityBackfillMigration, /INSERT INTO "DispatchWorkerCity"/);
  assert.match(cityBackfillMigration, /normalize_city_key/);
  assert.match(cityBackfillMigration, /ON CONFLICT \("workerId", "cityId"\) DO NOTHING/);
});