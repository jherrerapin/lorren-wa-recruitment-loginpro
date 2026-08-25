import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAdminSessionMiddleware } from '../src/services/adminSession.js';
import { buildAdminModuleNavbar } from '../src/services/adminNavigation.js';

class FakeStore {
  on() {}
}

function createHarness({ sessionData = {}, prismaClient, env = {} } = {}) {
  function fakeSessionModule() {
    return function fakeSessionMiddleware(req, _res, next) {
      req.session = sessionData;
      next();
    };
  }

  return createAdminSessionMiddleware({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test',
      SESSION_SECRET: 'test-secret',
      ...env
    },
    logger: { warn: () => {}, error: () => {} },
    sessionModule: fakeSessionModule,
    connectPgSimpleModule: () => FakeStore,
    prismaClient,
    bcryptModule: {
      hash: async (value) => `hash:${value}`,
      compare: async (plain, hash) => hash === `hash:${plain}`
    }
  });
}

async function runMiddleware(middleware, req = {}) {
  const events = [];
  let settled = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const finish = (event) => {
    events.push(event);
    if (!settled) {
      settled = true;
      resolveDone();
    }
  };
  const res = {
    status(code) {
      events.push(['status', code]);
      return this;
    },
    redirect(...args) {
      finish(['redirect', ...args]);
      return this;
    },
    render(...args) {
      finish(['render', ...args]);
      return this;
    },
    send(...args) {
      finish(['send', ...args]);
      return this;
    }
  };

  middleware({ query: {}, body: {}, ...req }, res, (error) => {
    if (error) {
      if (!settled) {
        settled = true;
        rejectDone(error);
      }
      return;
    }
    finish(['next']);
  });
  await done;
  return { events, res };
}

function profile(overrides = {}) {
  return {
    id: 'user-self-1',
    username: 'user-internal-1',
    passwordHash: 'hash:correct-password',
    displayName: 'Persona Prueba',
    email: 'persona@example.test',
    recoveryPhone: '3001234567',
    identityMigratedAt: new Date('2026-08-21T14:00:00.000Z'),
    lastPasswordResetAt: new Date('2026-08-22T14:00:00.000Z'),
    createdAt: new Date('2026-08-20T22:00:00.000Z'),
    role: 'ADMIN',
    accessScope: 'CITY',
    scopeCity: 'Bogotá',
    scopeVacancyId: null,
    canAccessDispatch: false,
    canAccessAttendance: false,
    canAccessStatistics: false,
    canAccessMetaAds: false,
    canAccessCvAnalysis: false,
    isActive: true,
    ...overrides
  };
}

function dbSession(overrides = {}) {
  return {
    userId: 'user-self-1',
    userRole: 'admin',
    username: 'user-internal-1',
    userSource: 'db',
    userAccessScope: 'CITY',
    displayName: 'Persona Prueba',
    userEmail: 'persona@example.test',
    identityMigratedAt: '2026-08-21T14:00:00.000Z',
    ...overrides
  };
}

test('Mi perfil carga solo la información del AppUser autenticado', async () => {
  const sessionData = dbSession();
  const prismaClient = {
    appUser: {
      findUnique: async ({ where }) => where.id === 'user-self-1' ? profile() : null
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });
  const result = await runMiddleware(middleware, {
    method: 'GET', path: '/account/profile', originalUrl: '/account/profile'
  });

  const render = result.events.find((event) => event[0] === 'render');
  assert.equal(render?.[1], 'accountProfile');
  assert.equal(render?.[2]?.displayName, 'Persona Prueba');
  assert.equal(render?.[2]?.email, 'persona@example.test');
  assert.equal(render?.[2]?.recoveryPhone, '3001234567');
});

test('el usuario actualiza únicamente sus datos personales aunque manipule campos administrativos', async () => {
  const sessionData = dbSession();
  const baseProfile = profile();
  let updated = null;
  const prismaClient = {
    appUser: {
      findUnique: async ({ where }) => {
        if (where.id === 'user-self-1') return baseProfile;
        if (where.email === 'nuevo@example.test') return null;
        return null;
      },
      update: async ({ where, data }) => {
        updated = { where, data };
        return { ...baseProfile, ...data };
      }
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });
  const result = await runMiddleware(middleware, {
    method: 'POST', path: '/account/profile', originalUrl: '/account/profile',
    body: {
      userId: 'other-user',
      role: 'DEV',
      accessScope: 'ALL',
      canAccessDispatch: 'on',
      displayName: 'Persona Actualizada',
      email: 'NUEVO@EXAMPLE.TEST',
      confirmEmail: 'nuevo@example.test',
      recoveryPhone: '+57 300 765 4321',
      currentPassword: 'correct-password'
    }
  });

  assert.deepEqual(updated?.where, { id: 'user-self-1' });
  assert.deepEqual(updated?.data, {
    displayName: 'Persona Actualizada',
    email: 'nuevo@example.test',
    recoveryEmail: 'nuevo@example.test',
    recoveryPhone: '573007654321'
  });
  assert.equal(sessionData.displayName, 'Persona Actualizada');
  assert.equal(sessionData.userEmail, 'nuevo@example.test');
  assert.deepEqual(result.events.at(-1), ['redirect', 303, '/account/profile?success=Perfil+actualizado+correctamente.']);
});

test('contraseña incorrecta impide cualquier escritura del perfil', async () => {
  let updates = 0;
  const prismaClient = {
    appUser: {
      findUnique: async ({ where }) => where.id === 'user-self-1' ? profile() : null,
      update: async () => { updates += 1; }
    }
  };
  const { middleware } = createHarness({ sessionData: dbSession(), prismaClient });
  const result = await runMiddleware(middleware, {
    method: 'POST', path: '/account/profile', originalUrl: '/account/profile',
    body: {
      displayName: 'Persona Prueba',
      email: 'persona@example.test',
      confirmEmail: 'persona@example.test',
      recoveryPhone: '3001234567',
      currentPassword: 'incorrecta'
    }
  });

  assert.equal(updates, 0);
  assert.equal(result.events.some((event) => event[0] === 'status' && event[1] === 401), true);
  assert.match(result.events.find((event) => event[0] === 'render')?.[2]?.error || '', /contraseña actual/i);
});

test('correo usado por otra cuenta e inválido de teléfono se rechazan sin escribir', async () => {
  for (const scenario of [
    { email: 'ocupado@example.test', phone: '3001234567', expectedStatus: 409 },
    { email: 'persona@example.test', phone: '12', expectedStatus: 400 }
  ]) {
    let updates = 0;
    const prismaClient = {
      appUser: {
        findUnique: async ({ where }) => {
          if (where.id === 'user-self-1') return profile();
          if (where.email === 'ocupado@example.test') return { id: 'other-user' };
          return null;
        },
        update: async () => { updates += 1; }
      }
    };
    const { middleware } = createHarness({ sessionData: dbSession(), prismaClient });
    const result = await runMiddleware(middleware, {
      method: 'POST', path: '/account/profile', originalUrl: '/account/profile',
      body: {
        displayName: 'Persona Prueba',
        email: scenario.email,
        confirmEmail: scenario.email,
        recoveryPhone: scenario.phone,
        currentPassword: 'correct-password'
      }
    });

    assert.equal(updates, 0);
    assert.equal(result.events.some((event) => event[0] === 'status' && event[1] === scenario.expectedStatus), true);
  }
});

test('DEV impersonando no puede abrir ni escribir el perfil del usuario objetivo', async () => {
  let queries = 0;
  let updates = 0;
  const sessionData = dbSession({
    devImpersonation: {
      origin: { userRole: 'dev', username: 'dev-env' },
      targetUserId: 'user-self-1'
    }
  });
  const prismaClient = {
    appUser: {
      findUnique: async () => { queries += 1; return profile(); },
      update: async () => { updates += 1; }
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });

  for (const method of ['GET', 'POST']) {
    const result = await runMiddleware(middleware, {
      method, path: '/account/profile', originalUrl: '/account/profile',
      body: method === 'POST' ? {
        displayName: 'Nombre Manipulado',
        email: 'manipulado@example.test',
        confirmEmail: 'manipulado@example.test',
        recoveryPhone: '3000000000',
        currentPassword: 'correct-password'
      } : {}
    });
    assert.equal(result.events.some((event) => event[0] === 'status' && event[1] === 403), true);
  }

  assert.equal(queries, 0, 'la protección ocurre antes de consultar el perfil impersonado');
  assert.equal(updates, 0);
});

test('la navegación enlaza Mi perfil para el usuario real y no durante impersonación', () => {
  const normal = buildAdminModuleNavbar({
    originalUrl: '/admin',
    session: dbSession()
  });
  assert.match(normal, /href="\/account\/profile"/);
  assert.match(normal, />Mi perfil<\/span>/);
  assert.match(normal, />Persona Prueba<\/span>/);
  assert.doesNotMatch(normal, /persona@example\.test/);

  const impersonated = buildAdminModuleNavbar({
    originalUrl: '/admin',
    session: dbSession({
      devImpersonation: {
        origin: { userRole: 'dev', username: 'dev-env' },
        targetUserId: 'user-self-1'
      }
    })
  });
  assert.doesNotMatch(impersonated, /\/account\/profile/);
  assert.match(impersonated, /Volver a DEV/);
});

test('la vista de Mi perfil no expone controles administrativos ni selector de usuario', () => {
  const source = readFileSync(new URL('../src/views/accountProfile.ejs', import.meta.url), 'utf8');
  assert.match(source, /name="displayName"/);
  assert.match(source, /name="email"/);
  assert.match(source, /name="recoveryPhone"/);
  assert.match(source, /name="currentPassword"/);
  assert.doesNotMatch(source, /name="userId"|name="role"|name="accessScope"|canAccessDispatch|dispatchAlertPhone/);
});
