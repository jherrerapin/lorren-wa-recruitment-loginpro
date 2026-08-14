import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function functionBlock(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `No se encontró ${startMarker}`);
  assert.notEqual(end, -1, `No se encontró ${endMarker}`);
  return content.slice(start, end);
}

test('dispatch personnel foundation exists', () => {
  const schema = readSource('prisma/schema.prisma');
  assert.match(schema, /model\s+DispatchWorker\s+{/);
  assert.match(schema, /model\s+DispatchWorkerCity\s+{/);
  assert.match(schema, /model\s+DispatchWorkerVacancy\s+{/);

  const migrationsDirUrl = new URL('../prisma/migrations', import.meta.url);
  const migrationsDirPath = fileURLToPath(migrationsDirUrl);
  const migrationFiles = readdirSync(migrationsDirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes('add_dispatch_worker_foundation'))
    .map((entry) => readFileSync(join(migrationsDirPath, entry.name, 'migration.sql'), 'utf8'));
  assert.ok(migrationFiles.length > 0, 'Debe existir migración de personal operativo.');
  assert.ok(migrationFiles.some((m) => /CREATE TABLE "DispatchWorker"/.test(m)));
  assert.ok(migrationFiles.some((m) => /CREATE TABLE "DispatchWorkerCity"/.test(m)));
  assert.ok(migrationFiles.some((m) => /CREATE TABLE "DispatchWorkerVacancy"/.test(m)));
});

test('contracted status sync and operations routes exist without webhook/fsm changes', () => {
  const syncService = readSource('src/services/dispatchWorkerSync.js');
  assert.match(syncService, /export\s+async\s+function\s+upsertDispatchWorkerFromCandidate/);

  const adminSource = readSource('src/routes/admin.js');
  assert.match(adminSource, /status\s*===\s*['"]CONTRATADO['"]\)\s*await\s+upsertDispatchWorkerFromCandidate\(prisma,\s*id\)/);

  const serverSource = readSource('src/server.js');
  assert.match(serverSource, /dispatchOpsExtrasRouter\(prisma\)/);

  const webhookSource = readSource('src/routes/webhook.js');
  assert.doesNotMatch(webhookSource, /upsertDispatchWorkerFromCandidate|\/sync-contratados|\/operaciones\/personal/);

  const fsmSource = readSource('src/services/conversationEngine.js');
  assert.doesNotMatch(fsmSource, /upsertDispatchWorkerFromCandidate|DispatchWorker/);
});

test('personal operativo solo consulta contratados y no expone filtro ni columna de estado', () => {
  const extrasSource = readSource('src/routes/dispatchOpsExtras.js');
  const personnelView = readSource('src/views/operacionesPersonal.ejs');
  const personalRoute = functionBlock(extrasSource, "router.get('/personal'", "router.get('/personal/importar-excel'");

  assert.match(extrasSource, /function buildDispatchEligibilityFilter\(\)\s*{\s*return \{ operationalStatus: 'CONTRATADO' \};\s*}/);
  assert.match(personalRoute, /const eligibilityFilter = buildDispatchEligibilityFilter\(\)/);
  assert.match(personalRoute, /\.\.\.eligibilityFilter/);
  assert.doesNotMatch(personalRoute, /req\.query\.status|filters:[^\n]*status/);

  assert.doesNotMatch(personnelView, /name="status"/);
  assert.doesNotMatch(personnelView, /<th>Estado<\/th>/);
  assert.doesNotMatch(personnelView, /row-inactive|\bReactivar\b|isActive \?/);
  assert.match(personnelView, />Desactivar<\/button>/);
});

test('personal operativo ajusta contenedor, filtros y tabla por resolución sin comprimir contenido', () => {
  const personnelView = readSource('src/views/operacionesPersonal.ejs');

  assert.match(personnelView, /--content-max:\s*1160px/);
  assert.match(personnelView, /\.page \{ width: min\(var\(--content-max\), calc\(100% - 40px\)\)/);
  assert.match(personnelView, /\.filters-grid \{ display: grid; grid-template-columns: minmax\(220px, \.85fr\) minmax\(320px, 1\.35fr\) auto/);
  assert.match(personnelView, /\.table-wrap \{ max-width: 100%; overflow-x: auto;/);
  assert.match(personnelView, /table \{ width: 100%; border-collapse: collapse; min-width: 1060px;/);
  assert.match(personnelView, /@media \(max-width: 1100px\)/);
  assert.match(personnelView, /@media \(max-width: 760px\)/);
  assert.match(personnelView, /@media \(max-width: 520px\)/);
  assert.doesNotMatch(personnelView, /@media \(max-width: 640px\)[\s\S]{0,250}\.btn \{ width: 100%; \}/);
});

test('assignment list remains limited to contracted workers', () => {
  const extrasSource = readSource('src/routes/dispatchOpsExtras.js');
  const assignmentView = readSource('src/views/operacionesAsignacionesConfirmacion.ejs');

  assert.match(extrasSource, /const baseWorkerWhere = \{ operationalStatus: 'CONTRATADO'/);
  assert.doesNotMatch(assignmentView, /name="status"/);
});
