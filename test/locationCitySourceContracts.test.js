import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('city source contracts separate recruitment dispatch and admin cities', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const route = fs.readFileSync('src/routes/locations.js', 'utf8');
  const view = fs.readFileSync('src/views/locations.ejs', 'utf8');
  const migration = fs.readFileSync('prisma/migrations/20260520013000_add_city_source_module/migration.sql', 'utf8');

  assert.match(schema, /enum CitySourceModule/);
  assert.match(schema, /RECRUITMENT/);
  assert.match(schema, /DISPATCH/);
  assert.match(schema, /ADMIN/);
  assert.match(schema, /sourceModule\s+CitySourceModule\s+@default\(RECRUITMENT\)/);
  assert.match(schema, /@@index\(\[sourceModule\]\)/);

  assert.match(migration, /CREATE TYPE "CitySourceModule" AS ENUM \('RECRUITMENT', 'DISPATCH', 'ADMIN'\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "sourceModule" "CitySourceModule" NOT NULL DEFAULT 'RECRUITMENT'/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "City_sourceModule_idx"/);

  assert.match(route, /CITY_SOURCE_ORDER = \['RECRUITMENT', 'DISPATCH', 'ADMIN'\]/);
  assert.match(route, /groupCitiesBySource/);
  assert.match(route, /sourceModule: 'asc'/);
  assert.match(route, /normalizeCitySourceModule\(req\.body\.sourceModule\)/);
  assert.match(route, /citySections: groupCitiesBySource\(cities\)/);

  assert.match(view, /citySections/);
  assert.match(view, /section-<%= section\.sourceModule %>/);
  assert.match(view, /source-badge/);
  assert.match(view, /Bot \/ Reclutamiento/);
  assert.match(view, /Despacho/);
  assert.match(view, /Administración/);
  assert.match(view, /name="sourceModule"/);
});
