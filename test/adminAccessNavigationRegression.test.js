import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { adminCandidateGlobalExportRouter } from '../src/routes/adminCandidateGlobalExport.js';
import {
  requireCvAnalysis,
  requireLorenV2,
  requireMetaAds
} from '../src/services/lorenV2Gate.js';

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

function sessionFixture(overrides = {}) {
  return {
    userRole: 'admin',
    username: 'TEST-recruiter',
    userAccessScope: 'ALL',
    canAccessMetaAds: false,
    canAccessCvAnalysis: false,
    ...overrides
  };
}

test('el router de exportación no intercepta /admin cuando la sesión ya venció', async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = {};
    next();
  });
  app.use('/admin', adminCandidateGlobalExportRouter({}));
  app.get('/admin', (_req, res) => res.redirect('/login'));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/admin`, {
      redirect: 'manual',
      headers: { accept: 'text/html' }
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  } finally {
    await close(server);
  }
});

test('las rutas de exportación siguen protegidas y una sesión vencida vuelve al login', async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = {};
    next();
  });
  app.use('/admin', adminCandidateGlobalExportRouter({}));

  const server = await listen(app);
  try {
    const { port } = server.address();
    for (const path of ['/admin/export', '/admin/export-global']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: 'manual',
        headers: { accept: 'text/html' }
      });
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get('location'), '/login', path);
    }
  } finally {
    await close(server);
  }
});

test('una navegación HTML a Estadísticas evita páginas crudas de sesión o permiso', async () => {
  const app = express();
  app.use((req, _res, next) => {
    const mode = req.query.mode;
    req.session = mode === 'expired' ? {} : sessionFixture();
    req.userRole = req.session.userRole || null;
    req.username = req.session.username || null;
    req.userAccessScope = req.session.userAccessScope || 'ALL';
    req.canAccessMetaAds = Boolean(req.session.canAccessMetaAds);
    req.canAccessCvAnalysis = Boolean(req.session.canAccessCvAnalysis);
    next();
  });
  app.get('/admin/estadisticas', requireLorenV2, (_req, res) => res.send('ok'));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const expired = await fetch(`http://127.0.0.1:${port}/admin/estadisticas?mode=expired`, {
      redirect: 'manual',
      headers: { accept: 'text/html' }
    });
    assert.equal(expired.status, 302);
    assert.equal(expired.headers.get('location'), '/login');

    const forbidden = await fetch(`http://127.0.0.1:${port}/admin/estadisticas?mode=forbidden`, {
      redirect: 'manual',
      headers: { accept: 'text/html' }
    });
    assert.equal(forbidden.status, 302);
    assert.equal(forbidden.headers.get('location'), '/admin');
  } finally {
    await close(server);
  }
});

test('las guardas de submódulos usan la misma navegación segura sin conceder acceso', async () => {
  const middlewares = [requireMetaAds, requireCvAnalysis];
  for (const middleware of middlewares) {
    const redirects = [];
    let nextCalled = false;
    const req = {
      method: 'GET',
      userRole: 'admin',
      username: 'TEST-recruiter',
      userAccessScope: 'ALL',
      canAccessMetaAds: false,
      canAccessCvAnalysis: false,
      session: sessionFixture(),
      accepts: (type) => type === 'html' ? 'html' : false
    };
    const res = {
      redirect: (location) => {
        redirects.push(location);
        return location;
      },
      status: () => ({ send: () => assert.fail('La navegación HTML debe redirigir') })
    };

    middleware(req, res, () => { nextCalled = true; });
    assert.deepEqual(redirects, ['/admin']);
    assert.equal(nextCalled, false);
  }
});

test('clientes no HTML conservan 401/403 y los perfiles autorizados continúan', () => {
  let expiredStatus = null;
  requireLorenV2({
    method: 'GET',
    accepts: () => false,
    session: {}
  }, {
    status: (status) => {
      expiredStatus = status;
      return { send: () => {} };
    }
  }, () => assert.fail('Una sesión vencida no debe pasar'));
  assert.equal(expiredStatus, 401);

  let forbiddenStatus = null;
  requireLorenV2({
    method: 'GET',
    userRole: 'admin',
    username: 'TEST-recruiter',
    userAccessScope: 'ALL',
    canAccessMetaAds: false,
    canAccessCvAnalysis: false,
    accepts: () => false,
    session: sessionFixture()
  }, {
    status: (status) => {
      forbiddenStatus = status;
      return { send: () => {} };
    }
  }, () => assert.fail('Un perfil sin permiso no debe pasar'));
  assert.equal(forbiddenStatus, 403);

  let allowed = false;
  requireLorenV2({ userRole: 'dev' }, {
    status: () => ({ send: () => assert.fail('DEV debe conservar acceso') })
  }, () => { allowed = true; });
  assert.equal(allowed, true);
});
