import express from 'express';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeHttpUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
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

export function dispatchBridgeRouter() {
  const router = express.Router();

  router.get('/', requireOps, (_req, res) => {
    return res.redirect('/admin/operaciones/abrir');
  });

  router.get('/abrir', requireOps, (_req, res) => {
    const dispatchModuleUrl = normalizeHttpUrl(process.env.DISPATCH_MODULE_URL);

    if (!dispatchModuleUrl) {
      return res.status(503).send('Panel operativo no configurado.');
    }

    return res.redirect(dispatchModuleUrl);
  });

  return router;
}
