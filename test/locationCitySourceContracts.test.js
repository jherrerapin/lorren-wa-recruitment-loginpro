import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('city source contracts separate recruitment and dispatch cities', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const route = fs.readFileSync('src/routes/locations.js', 'utf8');
  const view = fs.readFileSync('src/views/locations.ejs', 'utf8');
  const initialMigration = fs.readFileSync('prisma/migrations/20260520013000_add_city_source_module/migration.sql', 'utf8');
  const removeAdminMigration = fs.readFileSync('prisma/migrations/20260520071500_remove_admin_city_source/migration.sql', 'utf8');

  assert.match(schema, /enum CitySourceModule/);
  assert.match(schema, /RECRUITMENT/);
  assert.match(schema, /DISPATCH/);
  assert.doesNotMatch(schema, /\n\s*ADMIN\s*\n/);
  assert.match(schema, /sourceModule\s+CitySourceModule\s+@default\(RECRUITMENT\)/);
  assert.match(schema, /@@index\(\[sourceModule\]\)/);

  assert.match(initialMigration, /ADD COLUMN IF NOT EXISTS "sourceModule" "CitySourceModule" NOT NULL DEFAULT 'RECRUITMENT'/);
  assert.match(initialMigration, /CREATE INDEX IF NOT EXISTS "City_sourceModule_idx"/);
  assert.match(removeAdminMigration, /WHERE "sourceModule" = 'ADMIN'/);
  assert.match(removeAdminMigration, /CREATE TYPE "CitySourceModule" AS ENUM \('RECRUITMENT', 'DISPATCH'\)/);

  assert.match(route, /CITY_SOURCE_ORDER = \['RECRUITMENT', 'DISPATCH'\]/);
  assert.doesNotMatch(route, /ADMIN/);
  assert.match(route, /groupCitiesBySource/);
  assert.match(route, /sourceModule: 'asc'/);
  assert.match(route, /normalizeCitySourceModule\(req\.body\.sourceModule\)/);
  assert.match(route, /citySections: groupCitiesBySource\(cities\)/);

  assert.match(view, /citySections/);
  assert.match(view, /section-<%= section\.sourceModule %>/);
  assert.match(view, /source-badge/);
  assert.match(view, /Bot \/ Reclutamiento/);
  assert.match(view, /Despacho/);
  assert.doesNotMatch(view, /Administración/);
  assert.doesNotMatch(view, /value="ADMIN"/);
  assert.match(view, /name="sourceModule"/);
});
