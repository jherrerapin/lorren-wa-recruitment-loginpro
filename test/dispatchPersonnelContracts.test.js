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

test('dispatch personnel foundation remains compatible while branch becomes authority', () => {
  const schema = readSource('prisma/schema.prisma');
  assert.match(schema, /model\s+DispatchWorker\s+{/);
  assert.match(schema, /model\s+DispatchWorkerCity\s+{/);
  // Relación legacy conservada por expand/migrate/verify; no debe usarse para nuevas asignaciones.
  assert.match(schema, /model\s+DispatchWorkerVacancy\s+{/);

  const migrationsDirUrl = new URL('../prisma/migrations', import.meta.url);
  const migrationsDirPath = fileURLToPath(migrationsDirUrl);
  const migrationFiles = readdirSync(migrationsDirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes('add_dispatch_worker_foundation'))
    .map((entry) => readFileSync(join(migrationsDirPath, entry.name, 'migration.sql'), 'utf8'));
  assert.ok(migrationFiles.some((migration) => /CREATE TABLE "DispatchWorkerCity"/.test(migration)));
});

test('contratados se sincronizan a la sucursal de la operación sin escribir DispatchWorkerVacancy', () => {
  const syncService = readSource('src/services/dispatchWorkerSync.js');
  assert.match(syncService, /export\s+async\s+function\s+upsertDispatchWorkerFromCandidate/);
  assert.match(syncService, /operation:\s*{[\s\S]*city:\s*{\s*select:\s*{\s*id:\s*true,\s*name:\s*true/);
  assert.match(syncService, /dispatchWorkerCity\.upsert/);
  assert.doesNotMatch(syncService, /dispatchWorkerVacancy\.(?:upsert|create|createMany)/);

  const webhookSource = readSource('src/routes/webhook.js');
  assert.doesNotMatch(webhookSource, /upsertDispatchWorkerFromCandidate|\/sync-contratados|\/operaciones\/personal/);
  const fsmSource = readSource('src/services/conversationEngine.js');
  assert.doesNotMatch(fsmSource, /upsertDispatchWorkerFromCandidate|DispatchWorker/);
});

test('personal operativo consulta contratados y expone solo filtro de sucursal', () => {
  const extrasSource = readSource('src/routes/dispatchOpsExtras.js');
  const personnelView = readSource('src/views/operacionesPersonal.ejs');
  const personalRoute = functionBlock(extrasSource, "router.get('/personal'", "router.get('/personal/importar-excel'");

  assert.match(extrasSource, /function buildDispatchEligibilityFilter\(\)\s*{\s*return \{ operationalStatus: 'CONTRATADO' \};\s*}/);
  assert.match(personalRoute, /const eligibilityFilter = buildDispatchEligibilityFilter\(\)/);
  assert.match(personalRoute, /\.\.\.eligibilityFilter/);
  assert.doesNotMatch(personnelView, /name="vacancyId"|Vacantes \/ perfiles/);
  assert.match(personnelView, /name="operationalCityId"/);
  assert.match(personnelView, />Sucursal<\/label>/);
  assert.match(personnelView, /<th>Sucursales<\/th>/);
  assert.doesNotMatch(personnelView, /<th>Estado<\/th>/);
  assert.match(personnelView, />Desactivar<\/button>/);
});

test('alta y edición de auxiliar solo solicitan sucursales', () => {
  const workerView = readSource('src/views/operacionesPersonalNuevo.ejs');
  const listView = readSource('src/views/operacionesPersonal.ejs');

  assert.match(workerView, /name="cityIds"/);
  assert.match(workerView, /Sucursales habilitadas/);
  assert.match(workerView, /la sucursal es la única asignación territorial/);
  assert.doesNotMatch(workerView, /name="vacancyIds"|Vacantes \/ perfiles|selectedVacancyIds/);
  assert.match(listView, /href="\/operaciones\/admin-worker\/nuevo"/);
  assert.match(listView, /href="\/operaciones\/admin-worker\/<%= w\.id %>\/editar"/);
});

test('personal operativo conserva layout responsivo sin comprimir contenido', () => {
  const personnelView = readSource('src/views/operacionesPersonal.ejs');
  assert.match(personnelView, /--content-max:1160px/);
  assert.match(personnelView, /\.page \{ width:min\(var\(--content-max\),calc\(100% - 40px\)\)/);
  assert.match(personnelView, /\.filters-grid \{ display:grid; grid-template-columns:minmax\(260px,1fr\) auto/);
  assert.match(personnelView, /\.table-wrap \{ max-width:100%; overflow-x:auto/);
  assert.match(personnelView, /table \{ width:100%; border-collapse:collapse; min-width:930px/);
  assert.match(personnelView, /@media\(max-width:900px\)/);
  assert.match(personnelView, /@media\(max-width:520px\)/);
});

test('assignment list remains limited to contracted workers', () => {
  const extrasSource = readSource('src/routes/dispatchOpsExtras.js');
  const assignmentView = readSource('src/views/operacionesAsignacionesConfirmacion.ejs');
  assert.match(extrasSource, /const baseWorkerWhere = \{ operationalStatus: 'CONTRATADO'/);
  assert.doesNotMatch(assignmentView, /name="status"/);
});