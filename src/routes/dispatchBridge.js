import express from 'express';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isOpsUser(req) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}

function canUseOps(req) {
  const role = req.session?.userRole || req.userRole;
  return role === 'dev' || isOpsUser(req);
}

function requireOps(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.redirect('/login');
  if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
  return next();
}

function renderOperationsDashboard(res, options = {}) {
  return res.render('operacionesDashboard', {
    pageTitle: 'Operaciones / Despacho',
    subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.',
    activeSection: 'dashboard',
    ...options
  });
}

export function dispatchBridgeRouter() {
  const router = express.Router();

  router.get('/', requireOps, (_req, res) => {
    return renderOperationsDashboard(res);
  });

  router.get('/abrir', requireOps, (_req, res) => {
    return renderOperationsDashboard(res);
  });

  router.get('/solicitudes', requireOps, (_req, res) => {
    return renderOperationsDashboard(res, {
      pageTitle: 'Solicitudes operativas',
      activeSection: 'solicitudes'
    });
  });

  router.get('/asignaciones', requireOps, (_req, res) => {
    return renderOperationsDashboard(res, {
      pageTitle: 'Asignaciones operativas',
      activeSection: 'asignaciones'
    });
  });

  router.get('/novedades', requireOps, (_req, res) => {
    return renderOperationsDashboard(res, {
      pageTitle: 'Novedades operativas',
      activeSection: 'novedades'
    });
  });

  return router;
}
