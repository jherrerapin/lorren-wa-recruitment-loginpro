import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('sucursales reemplaza la clasificación funcional de ciudades sin contrato destructivo', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const route = fs.readFileSync('src/routes/locations.js', 'utf8');
  const view = fs.readFileSync('src/views/locations.ejs', 'utf8');
  const migration = fs.readFileSync('prisma/migrations/20260817223000_consolidate_branches_and_bogota_siberia/migration.sql', 'utf8');

  assert.match(schema, /usedForRecruitment\s+Boolean/);
  assert.match(schema, /usedForDispatch\s+Boolean/);
  assert.match(migration, /"usedForRecruitment" = TRUE/);
  assert.match(migration, /"usedForDispatch" = TRUE/);

  assert.doesNotMatch(route, /CITY_USAGE_ORDER|resolveCityUsage|groupCitiesByUsage|cityUsageBadges/);
  assert.match(route, /unifiedBranchCompatibilityData/);
  assert.match(route, /Siberia pertenece a la sucursal Bogotá/);
  assert.match(route, /isSiberiaName\(name\) && !isBogotaName\(city\.name\)/);
  assert.match(route, /La operación Siberia solo puede pertenecer a la sucursal Bogotá/);
  assert.doesNotMatch(view, /name="usedForRecruitment"|name="usedForDispatch"|Bot \/ Reclutamiento.*Despacho o ambos/);
  assert.match(view, /<h1>Sucursales<\/h1>/);
  assert.match(view, /Bogotá incluye Siberia/);
  assert.doesNotMatch(view, /href="\/admin\/vacancies"/);
});

test('Sucursales es superficie única y delega Vacancy/InterviewSlot a admin.js', () => {
  const route = fs.readFileSync('src/routes/locations.js', 'utf8');
  const adminRoute = fs.readFileSync('src/routes/admin.js', 'utf8');
  const view = fs.readFileSync('src/views/locations.ejs', 'utf8');
  const fields = fs.readFileSync('src/views/partials/locationOperationConfigFields.ejs', 'utf8');

  assert.match(route, /prisma\.operation\.create/);
  assert.doesNotMatch(route, /(?:prisma|tx)\.vacancy\.(?:create|update|updateMany|delete|deleteMany|upsert)/);
  assert.doesNotMatch(route, /(?:prisma|tx)\.interviewSlot\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)/);

  assert.match(adminRoute, /router\.post\('\/vacancies\/create'/);
  assert.match(adminRoute, /tx\.vacancy\.create/);
  assert.match(adminRoute, /router\.post\('\/vacancies\/:id\/edit'/);
  assert.match(adminRoute, /tx\.vacancy\.update/);
  assert.match(adminRoute, /syncVacancyInterviewSlots/);

  assert.match(view, /action="\/admin\/vacancies\/create"/);
  assert.match(view, /action="\/admin\/vacancies\/<%= config\.id %>\/edit"/);
  assert.match(view, /data-create-operation-form/);
  assert.match(view, /postCanonicalVacancy/);
  assert.match(view, /Editar información/);
  assert.match(view, /configuraciones históricas/);

  assert.match(fields, /name="operationId"/);
  assert.match(fields, /name="title"/);
  assert.match(fields, /name="description"/);
  assert.match(fields, /name="requirements"/);
  assert.match(fields, /name="conditions"/);
  assert.match(fields, /name="isActive"/);
  assert.match(fields, /name="acceptingApplications"/);
  assert.match(fields, /name="schedulingEnabled"/);
  assert.match(fields, /name="slotDays"/);
  assert.match(fields, /name="slotStartTime"/);
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
  const nativeBareCall = /(?<![\w$.])(?:alert|confirm|prompt)\s*\(/;
  const nativeWindowReference = /\b(?:window|globalThis)\s*\.\s*(?:alert|confirm|prompt)\b/;
  for (const path of [
    'src/views/locations.ejs',
    'src/views/operacionesClientes.ejs',
    'src/views/operacionesPersonal.ejs',
    'src/views/operacionesPersonalNuevo.ejs',
    'src/views/operacionesPersonalImportar.ejs'
  ]) {
    const source = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(source, nativeBareCall, `${path} no debe usar diálogos nativos`);
    assert.doesNotMatch(source, nativeWindowReference, `${path} no debe usar window.alert/confirm/prompt`);
  }
  assert.match(fs.readFileSync('src/views/locations.ejs', 'utf8'), /\/public\/lorren-dialog\.js/);
  assert.match(fs.readFileSync('src/views/operacionesClientes.ejs', 'utf8'), /\/public\/lorren-dialog\.js/);
});