import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { locationsRouter } from '../src/routes/locations.js';
import { sanitizeUsersPermissionCopy } from '../src/services/dispatchAuditMiddleware.js';
import { setPayrollFeatureAccess } from '../src/services/payrollFeatureAccess.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function generalSession(overrides = {}) {
  return {
    userRole: 'admin',
    userId: 'manager-1',
    username: 'reclutador-general',
    userSource: 'db',
    userAccessScope: 'ALL',
    ...overrides
  };
}

function payrollPrisma({ targetUsername = 'user-payroll-target' } = {}) {
  const events = [];
  const prisma = {
    appUser: {
      async findUnique({ where }) {
        return {
          id: where.id || 'user-payroll-target',
          username: targetUsername,
          role: 'ADMIN',
          isActive: true
        };
      }
    },
    devAuditEvent: {
      async findFirst() {
        return events.length ? events.at(-1).data : null;
      },
      async create(input) {
        events.push(input);
        return input;
      }
    }
  };
  return { prisma, events };
}

test('Gestión de Tiempo conserva su ruta operativa pero atraviesa las guardas con permiso propio', async () => {
  const bridge = await read('src/routes/dispatchBridge.js');
  const attendance = await read('src/routes/dispatchAttendanceAdmin.js');
  assert.match(attendance, /router\.use\('\/gestion-tiempo', dispatchPayrollRouter\(prisma\)\);/);
  assert.match(bridge, /isPayrollRequest/);
  assert.match(bridge, /req\.canAccessPayrollFeature/);
  assert.match(bridge, /resolvePayrollFeatureAccess/);
});

test('Gestión de Tiempo operativa conserva exclusivamente su permiso propio', async () => {
  const source = await read('src/routes/dispatchPayroll.js');
  assert.match(source, /resolvePayrollFeatureAccess/);
  assert.doesNotMatch(source, /resolveTestWorkspaceFeatureAccess/);
  assert.match(source, /No tienes permiso para acceder a Gestión de Tiempo y tiempo trabajado/);
  assert.match(source, /router\.get\('\/export\.csv'/);
  assert.match(source, /router\.get\('\/export\.xlsx'/);
});

test('el entorno de pruebas valida su permiso y calcula dentro de su propia ruta', async () => {
  const route = await read('src/routes/dispatchDevPayrollTest.js');
  assert.match(route, /resolveTestWorkspaceFeatureAccess/);
  assert.match(route, /loadTestWorkspacePayrollReport/);
  assert.match(route, /No tienes permiso para acceder al entorno de pruebas/);
});

test('Usuarios inyecta Gestión de Tiempo para la autoridad canónica y mantiene DEV_TEST solo para DEV', async () => {
  const middleware = await read('src/services/dispatchAuditMiddleware.js');
  const client = await read('src/public/payroll-user-access.js');
  assert.match(middleware, /canManageUserModulePermissions\(req\)/);
  assert.match(middleware, /data-can-manage-test-workspace/);
  assert.match(middleware, /PAYROLL_USERS_SCRIPT/);
  assert.match(client, /apiBase: '\/admin\/locations\/users'/);
  assert.match(client, /accessSuffix: 'payroll-access'/);
  assert.match(client, /get\('userId'\)/);
  assert.match(client, /canManageTestWorkspace/);
  assert.doesNotMatch(client, /by-username/);
});

test('el HTML de Usuarios no expone nombres de roles internos en ayudas de permisos', () => {
  const input = `
    <p>Los permisos adicionales solo pueden ser concedidos por DEV o reclutador-general.</p>
    <div>Puedes crear usuarios dentro de tu alcance. Los permisos adicionales del panel los asigna DEV o reclutador-general.</div>
    <span>Solo DEV y reclutador-general pueden modificar estos permisos.</span>
  `;
  const output = sanitizeUsersPermissionCopy(input);
  assert.doesNotMatch(output, /Solo DEV y reclutador-general|DEV o reclutador-general/);
});

test('reclutador-general puede conceder Gestión de Tiempo sin recibir permisos parentales', async () => {
  const { prisma, events } = payrollPrisma();
  const result = await setPayrollFeatureAccess(prisma, {
    targetUserId: 'user-payroll-target',
    enabled: true,
    actorRole: 'admin',
    actorUsername: 'reclutador-general',
    actorSource: 'db',
    actorAccessScope: 'ALL'
  });

  assert.equal(result.enabled, true);
  assert.equal(result.independentPermission, true);
  assert.equal(result.parentPermissionsChanged, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.actorRole, 'admin');
  assert.equal(events[0].data.metadata.permission, 'PAYROLL');
  assert.equal(events[0].data.metadata.parentPermissionsChanged, false);
});

test('un admin ordinario y el antiguo admin de entorno no pueden conceder Gestión de Tiempo', async () => {
  for (const actor of [
    {
      actorRole: 'admin',
      actorUsername: 'reclutador-sucursal',
      actorSource: 'db',
      actorAccessScope: 'ALL'
    },
    {
      actorRole: 'admin',
      actorUsername: 'admin-entorno-prueba',
      actorSource: 'env',
      actorAccessScope: 'ALL'
    }
  ]) {
    const { prisma, events } = payrollPrisma();
    await assert.rejects(
      () => setPayrollFeatureAccess(prisma, {
        targetUserId: 'user-payroll-target',
        enabled: true,
        ...actor
      }),
      /payroll_access_dev_required/
    );
    assert.equal(events.length, 0);
  }
});

test('la API canónica de Usuarios permite a reclutador-general activar y retirar Gestión de Tiempo', async () => {
  const { prisma, events } = payrollPrisma();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = generalSession();
    next();
  });
  app.use('/admin/locations', locationsRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const enabled = await fetch(`http://127.0.0.1:${port}/admin/locations/users/user-payroll-target/payroll-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).enabled, true);

    const current = await fetch(`http://127.0.0.1:${port}/admin/locations/users/user-payroll-target/payroll-access`);
    assert.equal(current.status, 200);
    assert.equal((await current.json()).enabled, true);

    const disabled = await fetch(`http://127.0.0.1:${port}/admin/locations/users/user-payroll-target/payroll-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).enabled, false);
    assert.equal(events.length, 2);
  } finally {
    await close(server);
  }
});

test('la API canónica de Usuarios rechaza un admin ordinario', async () => {
  const { prisma, events } = payrollPrisma();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = generalSession({
      userId: 'ordinary-1',
      username: 'reclutador-sucursal',
      userAccessScope: 'CITY'
    });
    next();
  });
  app.use('/admin/locations', locationsRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/admin/locations/users/user-payroll-target/payroll-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(response.status, 403);
    assert.equal(events.length, 0);
  } finally {
    await close(server);
  }
});

test('conceder Gestión de Tiempo mantiene una sola autoridad persistente y no cambia módulos padre', async () => {
  const service = await read('src/services/payrollFeatureAccess.js');
  const locations = await read('src/routes/locations.js');
  assert.match(service, /canManageUserModulePermissions/);
  assert.doesNotMatch(service, /canAccessDispatch: true, canAccessAttendance: true/);
  assert.match(service, /parentPermissionsChanged: false/);
  assert.match(service, /PAYROLL_ACCESS_ENABLED/);
  assert.match(service, /PAYROLL_ACCESS_DISABLED/);
  assert.match(locations, /router\.get\('\/users\/:id\/payroll-access'/);
  assert.match(locations, /router\.post\('\/users\/:id\/payroll-access'/);
  assert.match(locations, /setPayrollFeatureAccess/);
});

test('la exportación usa únicamente los trece conceptos canónicos vigentes', async () => {
  const engine = await read('src/modules/dispatch-payroll/domain/payrollConceptEngine.js');
  const expected = [
    'HEDO', 'HENO', 'HEDD', 'HEND', 'HEDF', 'HENF',
    'RNO', 'RDD', 'RND', 'RDF', 'RNF', 'RDDC', 'RNDC'
  ];
  for (const code of expected) assert.match(engine, new RegExp(`'${code}'`));
  assert.doesNotMatch(engine, /RDFC|RNFC/);
  assert.match(engine, /minutesToDecimalHours/);
});
