import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  clientMatchesOperationalCityScope,
  filterOperationalClientsByCityScope
} from '../src/services/cityOptions.js';
import {
  dispatchClientBranchIds,
  resolveDispatchClientBranchSelection
} from '../src/services/dispatchClientBranches.js';

const view = fs.readFileSync(new URL('../src/views/operacionesClientes.ejs', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../prisma/migrations/20260928223000_dispatch_client_multi_branches/migration.sql', import.meta.url),
  'utf8'
);
const publicRoutes = fs.readFileSync(new URL('../src/routes/publicDispatchClient.js', import.meta.url), 'utf8');
const coreRoutes = fs.readFileSync(new URL('../src/routes/dispatchBridgeCore.js', import.meta.url), 'utf8');
const middleware = fs.readFileSync(new URL('../src/services/dispatchAuditMiddleware.js', import.meta.url), 'utf8');

const cities = [
  { id: 'city-bogota', name: 'Bogotá' },
  { id: 'city-neiva', name: 'Neiva' },
  { id: 'city-medellin', name: 'Medellín' }
];

function scopeFor(cityIds) {
  const selected = cities.filter((city) => cityIds.includes(city.id));
  return {
    restricted: true,
    selectionExplicit: false,
    allowedCities: selected,
    allowedCityIds: selected.map((city) => city.id),
    selectedCities: selected,
    selectedCityIds: selected.map((city) => city.id)
  };
}

function prismaForCities() {
  return {
    city: {
      findMany: async (args = {}) => {
        const requested = args?.where?.id?.in;
        return requested ? cities.filter((city) => requested.includes(city.id)) : cities;
      }
    }
  };
}

test('un cliente multiciudad es visible cuando cualquier sucursal cruza el alcance del usuario', () => {
  const client = {
    id: 'client-1',
    cityName: 'Bogotá',
    branchCityIds: ['city-bogota', 'city-neiva'],
    operationPoints: []
  };

  assert.equal(clientMatchesOperationalCityScope(client, scopeFor(['city-neiva'])), true);
  assert.equal(clientMatchesOperationalCityScope(client, scopeFor(['city-medellin'])), false);
  assert.deepEqual(filterOperationalClientsByCityScope([client], scopeFor(['city-neiva'])).map((item) => item.id), ['client-1']);
});

test('clientes anteriores conservan fallback territorial por ciudad/operaciones', () => {
  const legacyByPrimary = { cityName: 'Neiva', operationPoints: [], branchCityIds: [] };
  const legacyByOperation = {
    cityName: 'Bogotá',
    branchCityIds: [],
    operationPoints: [{ id: 'point-1', cityName: 'Neiva' }]
  };

  assert.equal(clientMatchesOperationalCityScope(legacyByPrimary, scopeFor(['city-neiva'])), true);
  assert.equal(clientMatchesOperationalCityScope(legacyByOperation, scopeFor(['city-neiva'])), true);
});

test('selección de sucursales deduplica IDs y mantiene una ciudad de compatibilidad', async () => {
  const result = await resolveDispatchClientBranchSelection(
    prismaForCities(),
    { userRole: 'dev' },
    ['city-neiva', 'city-bogota', 'city-neiva']
  );

  assert.deepEqual(result.branchCityIds, ['city-neiva', 'city-bogota']);
  assert.equal(result.cityName, 'Neiva');
});

test('edición restringida preserva sucursales que el actor no puede ver ni retirar', async () => {
  const result = await resolveDispatchClientBranchSelection(
    prismaForCities(),
    {
      userRole: 'admin',
      userAccessScope: 'CITY',
      userAccessCity: 'Neiva'
    },
    ['city-neiva'],
    {
      existingClient: {
        cityName: 'Bogotá',
        branchCityIds: ['city-bogota', 'city-neiva']
      }
    }
  );

  assert.deepEqual(new Set(result.branchCityIds), new Set(['city-bogota', 'city-neiva']));
  assert.equal(dispatchClientBranchIds({ branchCityIds: result.branchCityIds }).length, 2);
});

test('una sucursal solicitada fuera del alcance se rechaza', async () => {
  await assert.rejects(
    () => resolveDispatchClientBranchSelection(
      prismaForCities(),
      { userRole: 'admin', userAccessScope: 'CITY', userAccessCity: 'Neiva' },
      ['city-medellin']
    ),
    (error) => error?.code === 'dispatch_client_branch_scope_forbidden'
  );
});

test('la persistencia y la UI usan branchCityIds/cityIds como autoridad multiselección', () => {
  assert.match(schema, /branchCityIds\s+String\[\]\s+@default\(\[\]\)/);
  assert.match(migration, /ADD COLUMN "branchCityIds" TEXT\[\]/);
  assert.match(migration, /FROM "DispatchOperationPoint" AS point/);
  assert.match(view, /name="cityIds"/);
  assert.match(view, /type="checkbox" name="cityIds"/);
  assert.doesNotMatch(view, /name="cityName"/);
  assert.doesNotMatch(view, /Sucursal principal/);
  for (const routeSource of [publicRoutes, coreRoutes]) {
    assert.match(routeSource, /resolveDispatchClientBranchSelection/);
    assert.match(routeSource, /branchCityIds: branches\.branchCityIds/);
  }
});

test('el middleware territorial autoriza clientes por cualquier sucursal asignada', () => {
  assert.match(middleware, /clientMatchesOperationalCityScope/);
  assert.match(middleware, /branchCityIds: true/);
  assert.match(middleware, /operationalCityIdsAllowed\(scope, requestedBranchIds\)/);
});
