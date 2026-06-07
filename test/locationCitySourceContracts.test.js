import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('city usage contracts allow recruitment dispatch or both', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const route = fs.readFileSync('src/routes/locations.js', 'utf8');
  const view = fs.readFileSync('src/views/locations.ejs', 'utf8');
  const dispatchRoute = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const dispatchView = fs.readFileSync('src/views/operacionesClientes.ejs', 'utf8');
  const migration = fs.readFileSync('prisma/migrations/20260520103000_add_city_usage_flags/migration.sql', 'utf8');

  assert.match(schema, /usedForRecruitment\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /usedForDispatch\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /@@index\(\[usedForRecruitment\]\)/);
  assert.match(schema, /@@index\(\[usedForDispatch\]\)/);

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "usedForRecruitment" BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "usedForDispatch" BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /"sourceModule" = 'RECRUITMENT'/);
  assert.match(migration, /"sourceModule" = 'DISPATCH'/);

  assert.match(route, /CITY_USAGE_ORDER = \['RECRUITMENT', 'DISPATCH'\]/);
  assert.match(route, /resolveCityUsage/);
  assert.match(route, /usedForRecruitment/);
  assert.match(route, /usedForDispatch/);
  assert.match(route, /cityUsageBadges/);
  assert.match(route, /groupCitiesByUsage/);

  assert.match(view, /name="usedForRecruitment"/);
  assert.match(view, /name="usedForDispatch"/);
  assert.match(view, /Una misma ciudad puede servir para Bot \/ Reclutamiento, Despacho o ambos usos/);
  assert.doesNotMatch(view, /name="sourceModule"/);
  assert.doesNotMatch(view, /value="ADMIN"/);

  assert.doesNotMatch(dispatchRoute, /admin-ciudades/);
  assert.match(dispatchRoute, /loadUnifiedCityOptions\(prisma\)/);
  assert.match(dispatchRoute, /filter\(\(city\) => city\.usedForDispatch\)/);
  assert.doesNotMatch(dispatchView, /Crear ciudad operativa/);
  assert.match(dispatchView, /Configurar ciudades/);
  assert.match(dispatchView, /Este módulo no crea ciudades/);
});
