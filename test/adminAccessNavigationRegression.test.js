import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { adminCandidateGlobalExportRouter } from '../src/routes/adminCandidateGlobalExport.js';
import { dispatchAuditMiddleware } from '../src/services/dispatchAuditMiddleware.js';
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

function attachSession(app, resolver = () => sessionFixture()) {
  app.use((req, _res, next) => {
    req.session = resolver(req) || {};
    req.userRole = req.session.userRole || null;
    req.username = req.session.username || null;
    req.userAccessScope = req.session.userAccessScope || 'ALL';
    req.canAccessMetaAds = Boolean(req.session.canAccessMetaAds);
    req.canAccessCvAnalysis = Boolean(req.session.canAccessCvAnalysis);
    next();
  });
}

function installAdminPresentationBridge(app) {
  app.use(dispatchAuditMiddleware({}));
}

async function request(server, path, { accept = 'text/html', redirect = 'manual' } = {}) {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${path}`, {
    redirect,
    headers: { accept }
  });
}

test('el router de exportación no intercepta /admin cuando la sesión ya venció', async () => {
  const app = express();
  attachSession(app, () => ({}));
  app.use('/admin', adminCandidateGlobalExportRouter({}));
  app.get('/admin', (_req, res) => res.redirect('/login'));

  const server = await listen(app);
  try {
    const response = await request(server, '/admin');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  } finally {
    await close(server);
  }
});

test('las rutas de exportación siguen protegidas y una sesión vencida vuelve al login', async () => {
  const app = express();
  attachSession(app, () => ({}));
  app.use('/admin', adminCandidateGlobalExportRouter({}));

  const server = await listen(app);
  try {
    for (const path of ['/admin/export', '/admin/export-global']) {
      const response = await request(server, path);
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get('location'), '/login', path);
    }
  } finally {
    await close(server);
  }
});

test('Estadísticas usa la presentación transversal: sesión vencida va al login y falta de permiso muestra 403 estético', async () => {
  const app = express();
  attachSession(app, (req) => req.query.mode === 'expired' ? {} : sessionFixture());
  installAdminPresentationBridge(app);
  app.get('/admin/estadisticas', requireLorenV2, (_req, res) => res.send('ok'));

  const server = await listen(app);
  try {
    const expired = await request(server, '/admin/estadisticas?mode=expired');
    assert.equal(expired.status, 302);
    assert.equal(expired.headers.get('location'), '/login');

    const forbidden = await request(server, '/admin/estadisticas?mode=forbidden');
    const body = await forbidden.text();
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.headers.get('content-type') || '', /text\/html/);
    assert.equal(forbidden.headers.get('cache-control'), 'no-store');
    assert.match(body, /Acceso no disponible/);
    assert.match(body, /No tienes acceso a esta sección o acción con tu perfil actual\./);
    assert.match(body, /Modulo no disponible para este perfil\./);
    assert.match(body, /href="\/admin"/);
    assert.match(body, /Volver al panel/);
    assert.match(body, /Cerrar sesión/);
    assert.doesNotMatch(body, /^Modulo no disponible para este perfil\.$/);
  } finally {
    await close(server);
  }
});

test('el 403 operativo reportado deja de ser texto plano sin cambiar la autorización', async () => {
  const app = express();
  attachSession(app);
  installAdminPresentationBridge(app);
  app.get('/admin/operaciones/clientes', (_req, res) => {
    assert.fail('La guarda operativa debió bloquear antes de llegar a la ruta');
    res.send('unexpected');
  });

  const server = await listen(app);
  try {
    const response = await request(server, '/admin/operaciones/clientes');
    const body = await response.text();
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(body, /Acceso no disponible/);
    assert.match(body, /No tienes permiso para realizar esta función operativa\./);
    assert.match(body, /Volver al panel/);
    assert.doesNotMatch(body, /^No tienes permiso para realizar esta función operativa\.$/);
  } finally {
    await close(server);
  }
});

test('cualquier 403 plano bajo /admin usa el mismo aviso visual sin modificar cada router', async () => {
  const app = express();
  attachSession(app);
  installAdminPresentationBridge(app);
  app.get('/admin/dev-only', (_req, res) => res.status(403).send('Acceso restringido a DEV.'));

  const server = await listen(app);
  try {
    const response = await request(server, '/admin/dev-only');
    const body = await response.text();
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(body, /Acceso no disponible/);
    assert.match(body, /Acceso restringido a DEV\./);
    assert.match(body, /Volver al panel/);
  } finally {
    await close(server);
  }
});

test('los aliases administrativos de operaciones reciben la misma presentación', async () => {
  const app = express();
  attachSession(app);
  installAdminPresentationBridge(app);
  app.get('/operaciones/admin-worker', (_req, res) => {
    assert.fail('La guarda operativa debió bloquear el alias antes de llegar a la ruta');
    res.send('unexpected');
  });

  const server = await listen(app);
  try {
    const response = await request(server, '/operaciones/admin-worker');
    const body = await response.text();
    assert.equal(response.status, 403);
    assert.match(body, /Acceso no disponible/);
    assert.match(body, /Volver al panel/);
  } finally {
    await close(server);
  }
});

test('las guardas de Meta Ads y Análisis HV reutilizan la misma autoridad visual sin conceder acceso', async () => {
  const app = express();
  attachSession(app);
  installAdminPresentationBridge(app);
  app.get('/admin/estadisticas/meta-test', requireMetaAds, (_req, res) => res.send('meta-ok'));
  app.get('/admin/estadisticas/cv-test', requireCvAnalysis, (_req, res) => res.send('cv-ok'));

  const server = await listen(app);
  try {
    for (const path of ['/admin/estadisticas/meta-test', '/admin/estadisticas/cv-test']) {
      const response = await request(server, path);
      const body = await response.text();
      assert.equal(response.status, 403, path);
      assert.match(body, /Acceso no disponible/, path);
      assert.match(body, /Volver al panel/, path);
      assert.doesNotMatch(body, /meta-ok|cv-ok/, path);
    }
  } finally {
    await close(server);
  }
});

test('clientes no HTML conservan el status y el cuerpo técnico original', async () => {
  const app = express();
  attachSession(app);
  installAdminPresentationBridge(app);
  app.get('/admin/dev-only', (_req, res) => res.status(403).send('Acceso restringido a DEV.'));

  const server = await listen(app);
  try {
    const response = await request(server, '/admin/dev-only', { accept: 'application/json' });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Acceso restringido a DEV.');
    assert.equal(response.headers.get('cache-control'), null);
  } finally {
    await close(server);
  }
});

test('una respuesta 403 que ya es una página HTML no se reemplaza por el aviso genérico', async () => {
  const app = express();
  attachSession(app);
  installAdminPresentationBridge(app);
  app.get('/admin/custom-denied', (_req, res) => res.status(403).send(
    '<!doctype html><html><body><h1>Denegación especializada</h1></body></html>'
  ));

  const server = await listen(app);
  try {
    const response = await request(server, '/admin/custom-denied');
    const body = await response.text();
    assert.equal(response.status, 403);
    assert.match(body, /Denegación especializada/);
    assert.doesNotMatch(body, /No tienes acceso a esta sección o acción con tu perfil actual\./);
  } finally {
    await close(server);
  }
});

test('las guardas conservan 401/403 para clientes técnicos y los perfiles autorizados continúan', () => {
  let expiredStatus = null;
  requireLorenV2({ session: {} }, {
    status: (status) => {
      expiredStatus = status;
      return { send: () => {} };
    }
  }, () => assert.fail('Una sesión vencida no debe pasar'));
  assert.equal(expiredStatus, 401);

  let forbiddenStatus = null;
  requireLorenV2({
    userRole: 'admin',
    username: 'TEST-recruiter',
    userAccessScope: 'ALL',
    canAccessMetaAds: false,
    canAccessCvAnalysis: false,
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
