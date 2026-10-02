import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/routes/locations.js', import.meta.url), 'utf8');

test('Sucursales filtra el listado con el alcance territorial de la sesión', () => {
  assert.match(source, /const branchScope = requestBranchScope\(req\);[\s\S]*const cities = filterCitiesForBranchScope\(allCities, branchScope\);/);
  assert.match(source, /branchScopeAllowsCity\(branchScope, city\.name\)/);
  assert.match(source, /branchScope\.accessScope !== 'VACANCY' \|\| operation\.vacancies\.some/);
});

test('un usuario con alcance limitado no puede crear ni alterar sucursales por request directo', () => {
  assert.match(source, /router\.post\('\/cities',[\s\S]*!branchScopeCanCreateCity\(branchScope\)/);
  assert.match(source, /router\.post\('\/cities\/:id\/edit',[\s\S]*!branchScopeCanCreateCity\(branchScope\)/);
  assert.match(source, /router\.post\('\/cities\/:id\/delete',[\s\S]*!branchScopeCanCreateCity\(branchScope\)/);
});

test('crear, renombrar o eliminar vacantes auxiliares exige acceso a la sucursal y VACANCY no amplía su alcance', () => {
  assert.match(source, /router\.post\('\/cities\/:cityId\/operations',[\s\S]*!branchScopeCanManageOperation\(branchScope, city\.name\)/);
  assert.match(source, /router\.post\('\/operations\/:id\/edit',[\s\S]*!branchScopeCanManageOperation\(branchScope, operation\.city\?\.name\)/);
  assert.match(source, /router\.post\('\/operations\/:id\/delete',[\s\S]*!branchScopeCanManageOperation\(branchScope, operation\.city\?\.name\)/);
  assert.match(source, /return scope\.accessScope !== 'VACANCY' && branchScopeAllowsCity\(scope, cityName\);/);
});
