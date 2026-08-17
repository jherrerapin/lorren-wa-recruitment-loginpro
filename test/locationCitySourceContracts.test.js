import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('sucursales reemplaza la clasificación funcional de ciudades sin contrato destructivo', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const route = fs.readFileSync('src/routes/locations.js', 'utf8');
  const view = fs.readFileSync('src/views/locations.ejs', 'utf8');
  const migration = fs.readFileSync('prisma/migrations/20260817223000_consolidate_branches_and_bogota_siberia/migration.sql', 'utf8');

  // Expand/migrate/verify: los campos físicos antiguos siguen disponibles durante
  // la transición, pero dejaron de ser una decisión de la interfaz y del CRUD.
  assert.match(schema, /usedForRecruitment\s+Boolean/);
  assert.match(schema, /usedForDispatch\s+Boolean/);
  assert.match(migration, /"usedForRecruitment" = TRUE/);
  assert.match(migration, /"usedForDispatch" = TRUE/);

  assert.doesNotMatch(route, /CITY_USAGE_ORDER|resolveCityUsage|groupCitiesByUsage|cityUsageBadges/);
  assert.match(route, /unifiedBranchCompatibilityData/);
  assert.match(route, /Siberia pertenece a la sucursal Bogotá/);
  assert.doesNotMatch(view, /name="usedForRecruitment"|name="usedForDispatch"|Bot \/ Reclutamiento.*Despacho o ambos/);
  assert.match(view, /<h1>Sucursales<\/h1>/);
  assert.match(view, /Bogotá incluye Siberia/);
  assert.doesNotMatch(view, /href="\/admin\/vacancies"/);
});

test('sucursal contiene operación y configuración consumida por Lórren', () => {
  const route = fs.readFileSync('src/routes/locations.js', 'utf8');
  const view = fs.readFileSync('src/views/locations.ejs', 'utf8');
  const fields = fs.readFileSync('src/views/partials/locationOperationConfigFields.ejs', 'utf8');

  assert.match(route, /buildRecruitmentConfigData/);
  assert.match(route, /tx\.operation\.create/);
  assert.match(route, /tx\.vacancy\.create/);
  assert.match(route, /operationId: operation\.id/);
  assert.match(route, /operations\/:operationId\/recruitment\/:vacancyId\/edit/);

  assert.match(view, /Cada sucursal contiene sus operaciones/);
  assert.match(view, /Editar información/);
  assert.match(view, /configuraciones históricas/);
  assert.match(fields, /name="title"/);
  assert.match(fields, /name="requirements"/);
  assert.match(fields, /name="conditions"/);
  assert.match(fields, /name="isActive"/);
  assert.match(fields, /name="acceptingApplications"/);
  assert.match(fields, /name="schedulingEnabled"/);
});

test('migración consolida Siberia en Bogotá y preserva autoridad territorial de auxiliares', () => {
  const migration = fs.readFileSync('prisma/migrations/20260817223000_consolidate_branches_and_bogota_siberia/migration.sql', 'utf8');

  assert.match(migration, /INSERT INTO "DispatchWorkerCity"/);
  assert.match(migration, /FROM "DispatchWorkerVacancy" AS dwv/);
  assert.match(migration, /JOIN "Operation" AS operation/);
  assert.match(migration, /ON CONFLICT \("workerId", "cityId"\) DO NOTHING/);
  assert.match(migration, /translate\(lower\(trim\(name\)\).*siberia/si);
  assert.match(migration, /UPDATE "DispatchWorkerCity"[\s\S]*SET "cityId" = bogota_id/);
  assert.match(migration, /UPDATE "Vacancy"[\s\S]*city = 'Bogotá'/);
  assert.match(migration, /DELETE FROM "City"[\s\S]*siberia_id/);
});

test('vistas modificadas no introducen diálogos nativos del navegador', () => {
  for (const path of [
    'src/views/locations.ejs',
    'src/views/operacionesClientes.ejs',
    'src/views/operacionesPersonal.ejs',
    'src/views/operacionesPersonalNuevo.ejs',
    'src/views/operacionesPersonalImportar.ejs'
  ]) {
    const source = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /\b(?:confirm|alert|prompt)\s*\(/, `${path} no debe usar diálogos nativos`);
  }
  assert.match(fs.readFileSync('src/views/locations.ejs', 'utf8'), /\/public\/lorren-dialog\.js/);
  assert.match(fs.readFileSync('src/views/operacionesClientes.ejs', 'utf8'), /\/public\/lorren-dialog\.js/);
});