import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('dispatch assignment board view contracts', () => {
  assert.ok(existsSync(new URL('../src/views/operacionesAsignaciones.ejs', import.meta.url)));

  const view = readSource('src/views/operacionesAsignaciones.ejs');
  assert.match(view, /draggable="true"/);
  assert.match(view, /data-worker-id/);
  assert.match(view, /assignmentDropZone/);
  assert.match(view, /name="q"/);
  assert.match(view, /name="operationalCityId"/);
  assert.doesNotMatch(view, /name="vacancyId"/);
  assert.match(view, /name="transportMode"/);
  assert.match(view, /name="locality"/);
  assert.match(view, /name="status"/);
});

test('dispatch bridge routes to visual assignment board and keeps boundaries', () => {
  const bridge = readSource('src/routes/dispatchBridge.js');
  assert.match(bridge, /router\.get\(\s*['"]\/asignaciones['"].*res\.render\(\s*['"]operacionesAsignaciones['"]/s);
  assert.match(bridge, /prisma\.dispatchWorker\.findMany/);

  const webhook = readSource('src/routes/webhook.js');
  assert.doesNotMatch(webhook, /operacionesAsignaciones|assignmentDropZone|dispatch assignment/i);

  const fsm = readSource('src/services/conversationEngine.js');
  assert.doesNotMatch(fsm, /operacionesAsignaciones|assignmentDropZone|dispatch assignment/i);

  const schema = readSource('prisma/schema.prisma');
  assert.doesNotMatch(schema, /operacionesAsignaciones|DispatchOperationRequest/);
  const migrationDirs = readdirSync(new URL('../prisma/migrations', import.meta.url), { withFileTypes: true }).map((entry) => entry.name);
  assert.ok(!migrationDirs.some((name) => /dispatch_assignment_board|operaciones_asignaciones/i.test(name)));
});

test('dispatch assignment transport filter uses normalized current transport data', () => {
  const bridge = readSource('src/routes/dispatchBridge.js');
  const sync = readSource('src/services/dispatchWorkerSync.js');
  const transport = readSource('src/services/transportMode.js');
  const manualWorkerView = readSource('src/views/operacionesPersonalNuevo.ejs');
  const migration = readSource('prisma/migrations/20260521162000_normalize_dispatch_worker_transport/migration.sql');

  assert.match(bridge, /normalizeTransportMode/);
  assert.match(bridge, /uniqueNormalizedTransportModes/);
  assert.match(bridge, /const transportWhere = \{[^}]*\.\.\.operationalCityFilter/s);
  assert.match(bridge, /transportModes: uniqueNormalizedTransportModes\(transportModeRows\.map\(\(row\) => row\.transportMode\)\)/);
  assert.doesNotMatch(bridge, /transportModes: transportModeRows\.map\(\(row\) => row\.transportMode\)\.filter\(Boolean\)/);

  assert.match(sync, /normalizeTransportMode\(candidate\.transportMode\)/);
  assert.match(manualWorkerView, /<select id="transportMode" name="transportMode">/);
  assert.match(manualWorkerView, /Bus, TransMilenio, SITP y colectivo se agrupan como Público/);

  assert.match(transport, /transmilenio/);
  assert.match(transport, /colectivo/);
  assert.match(transport, /sitp/);
  assert.match(transport, /return 'Público'/);

  assert.match(migration, /UPDATE "DispatchWorker"/);
  assert.match(migration, /UPDATE "Candidate"/);
  assert.match(migration, /THEN 'Público'/);
  assert.match(migration, /transmilenio/);
  assert.match(migration, /colectivo/);
});
