import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminSessionMiddleware } from '../src/services/adminSession.js';

class FakeStore {
  on() {}
}

function createHarness({ sessionData = {}, prismaClient, bcryptModule, env = {} } = {}) {
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
    bcryptModule: bcryptModule || {
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

  middleware(req, res, (error) => {
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
  return { events, req, res };
}

function migratedProfile(overrides = {}) {
  return {
    id: 'user-1',
    username: 'legacy-user',
    passwordHash: 'hash:correct-password',
    displayName: 'Persona Prueba',
    email: 'persona@example.test',
    identityMigratedAt: new Date('2026-08-19T20:00:00.000Z'),
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

test('todo usuario no DEV pendiente queda bloqueado antes del panel', async () => {
  const sessionData = {
    userId: 'user-1',
    userRole: 'admin',
    username: 'legacy-user',
    userSource: 'db',
    userAccessScope: 'ALL'
  };
  const prismaClient = {
    appUser: {
      findUnique: async ({ where }) => where.id === 'user-1'
        ? migratedProfile({ displayName: null, email: null, identityMigratedAt: null })
        : null
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });
  const result = await runMiddleware(middleware, { method: 'GET', path: '/admin', originalUrl: '/admin' });

  assert.deepEqual(result.events.at(-1), ['redirect', 303, '/account/identity']);
});

test('DEV queda exceptuado de la migración obligatoria', async () => {
  const sessionData = {
    userId: 'dev-1',
    userRole: 'dev',
    username: 'dev-env',
    userSource: 'env',
    userAccessScope: 'ALL'
  };
  const prismaClient = {
    appUser: {
      findUnique: async () => migratedProfile({
        id: 'dev-1', username: 'dev-env', role: 'DEV', displayName: null, email: null, identityMigratedAt: null
      })
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });
  const result = await runMiddleware(middleware, { method: 'GET', path: '/admin', originalUrl: '/admin' });

  assert.deepEqual(result.events.at(-1), ['next']);
});

test('login por correo se traduce al identificador interno antes de la autoridad existente', async () => {
  const sessionData = {};
  const prismaClient = {
    appUser: {
      findUnique: async ({ where }) => where.email === 'persona@example.test'
        ? { username: 'legacy-user', identityMigratedAt: new Date(), role: 'ADMIN' }
        : null
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });
  const req = {
    method: 'POST', path: '/login', originalUrl: '/login',
    body: { username: ' PERSONA@EXAMPLE.TEST ', password: 'secret' }
  };
  const result = await runMiddleware(middleware, req);

  assert.deepEqual(result.events.at(-1), ['next']);
  assert.equal(req.body.username, 'legacy-user');
});

test('username histórico deja de autenticar cuando la identidad ya fue migrada', async () => {
  const sessionData = {};
  const prismaClient = {
    appUser: {
      findUnique: async ({ where }) => where.username === 'legacy-user'
        ? { username: 'legacy-user', identityMigratedAt: new Date(), role: 'ADMIN' }
        : null
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });
  const req = {
    method: 'POST', path: '/login', originalUrl: '/login',
    body: { username: 'legacy-user', password: 'secret' }
  };
  await runMiddleware(middleware, req);

  assert.equal(req.body.username, '__login_requires_email__');
});

test('migración obligatoria confirma contraseña, normaliza correo y conserva la misma cuenta', async () => {
  const sessionData = {
    userId: 'user-1',
    userRole: 'admin',
    username: 'legacy-user',
    userSource: 'db',
    userAccessScope: 'ALL'
  };
  let updated = null;
  const baseProfile = migratedProfile({ displayName: null, email: null, identityMigratedAt: null });
  const prismaClient = {
    appUser: {
      findUnique: async ({ where }) => {
        if (where.id === 'user-1') return baseProfile;
        if (where.email === 'persona.nueva@example.test') return null;
        return null;
      },
      update: async ({ where, data }) => {
        updated = { where, data };
        return { ...baseProfile, ...data };
      }
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });
  const req = {
    method: 'POST', path: '/account/identity', originalUrl: '/account/identity',
    body: {
      displayName: 'Persona Nueva',
      email: 'PERSONA.NUEVA@EXAMPLE.TEST',
      confirmEmail: 'persona.nueva@example.test',
      currentPassword: 'correct-password'
    }
  };
  const result = await runMiddleware(middleware, req);

  assert.deepEqual(result.events.at(-1), ['redirect', 303, '/admin']);
  assert.deepEqual(updated.where, { id: 'user-1' });
  assert.equal(updated.data.displayName, 'Persona Nueva');
  assert.equal(updated.data.email, 'persona.nueva@example.test');
  assert.equal(updated.data.recoveryEmail, 'persona.nueva@example.test');
  assert.ok(updated.data.identityMigratedAt instanceof Date);
  assert.equal(updated.data.passwordHash, undefined, 'usuario DB conserva exactamente su hash actual');
  assert.equal(sessionData.displayName, 'Persona Nueva');
  assert.equal(sessionData.userEmail, 'persona.nueva@example.test');
  assert.ok(sessionData.identityMigratedAt);
});

test('un correo ya usado no puede completar la migración de otra cuenta', async () => {
  const sessionData = {
    userId: 'user-1', userRole: 'admin', username: 'legacy-user', userSource: 'db', userAccessScope: 'ALL'
  };
  let updates = 0;
  const baseProfile = migratedProfile({ displayName: null, email: null, identityMigratedAt: null });
  const prismaClient = {
    appUser: {
      findUnique: async ({ where }) => {
        if (where.id === 'user-1') return baseProfile;
        if (where.email === 'ocupado@example.test') return { id: 'other-user' };
        return null;
      },
      update: async () => { updates += 1; }
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });
  const result = await runMiddleware(middleware, {
    method: 'POST', path: '/account/identity', originalUrl: '/account/identity',
    body: {
      displayName: 'Persona Nueva',
      email: 'ocupado@example.test',
      confirmEmail: 'ocupado@example.test',
      currentPassword: 'correct-password'
    }
  });

  assert.equal(updates, 0);
  assert.equal(result.events.some((event) => event[0] === 'status' && event[1] === 409), true);
  const renderEvent = result.events.find((event) => event[0] === 'render');
  assert.equal(renderEvent?.[1], 'identityMigration');
  assert.match(renderEvent?.[2]?.error || '', /otro usuario/);
});

test('solo DEV puede iniciar una vista como usuario y puede volver a su sesión original', async () => {
  const devSession = {
    userId: 'dev-1',
    userRole: 'dev',
    username: 'dev-env',
    userSource: 'env',
    userAccessScope: 'ALL',
    displayName: 'DEV'
  };
  const audit = [];
  const target = migratedProfile({
    id: 'target-1', username: 'user-internal', displayName: 'Persona Objetivo', email: 'objetivo@example.test'
  });
  const prismaClient = {
    appUser: {
      findUnique: async ({ where }) => where.id === 'target-1' ? target : null
    },
    devAuditEvent: {
      create: async ({ data }) => { audit.push(data); }
    }
  };
  const { middleware } = createHarness({ sessionData: devSession, prismaClient });

  const start = await runMiddleware(middleware, {
    method: 'POST', path: '/admin/users/target-1/impersonate', originalUrl: '/admin/users/target-1/impersonate'
  });
  assert.deepEqual(start.events.at(-1), ['redirect', 303, '/admin']);
  assert.equal(devSession.userRole, 'admin');
  assert.equal(devSession.userId, 'target-1');
  assert.equal(devSession.displayName, 'Persona Objetivo');
  assert.equal(devSession.devImpersonation.origin.userRole, 'dev');
  assert.equal(audit[0].action, 'USER_IMPERSONATION_STARTED');

  const stop = await runMiddleware(middleware, {
    method: 'POST', path: '/admin/users/impersonation/stop', originalUrl: '/admin/users/impersonation/stop'
  });
  assert.deepEqual(stop.events.at(-1), ['redirect', 303, '/admin/users']);
  assert.equal(devSession.userRole, 'dev');
  assert.equal(devSession.userId, 'dev-1');
  assert.equal(devSession.displayName, 'DEV');
  assert.equal(devSession.devImpersonation, undefined);
  assert.equal(audit[1].action, 'USER_IMPERSONATION_FINISHED');
});

test('un reclutador no puede forzar la ruta de impersonación', async () => {
  const sessionData = {
    userId: 'user-1', userRole: 'admin', username: 'legacy-user', userSource: 'db', userAccessScope: 'ALL'
  };
  let targetQueries = 0;
  const prismaClient = {
    appUser: {
      findUnique: async () => { targetQueries += 1; return migratedProfile(); }
    }
  };
  const { middleware } = createHarness({ sessionData, prismaClient });
  const result = await runMiddleware(middleware, {
    method: 'POST', path: '/admin/users/target-1/impersonate', originalUrl: '/admin/users/target-1/impersonate'
  });

  assert.equal(result.events.some((event) => event[0] === 'status' && event[1] === 403), true);
  assert.deepEqual(result.events.at(-1), ['send', 'Acceso restringido a DEV']);
  assert.equal(targetQueries, 0, 'la autorización ocurre antes de consultar al usuario objetivo');
});
