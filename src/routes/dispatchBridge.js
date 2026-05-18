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

function requireDevSession(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.redirect('/login');
  if (role !== 'dev') return res.status(403).send('Acceso restringido a desarrolladores');
  return next();
}

export function dispatchBridgeRouter() {
  const router = express.Router();

  router.get('/abrir', requireDevSession, (req, res) => {
    const dispatchModuleUrl = normalizeHttpUrl(process.env.DISPATCH_MODULE_URL);

    if (!dispatchModuleUrl) {
      return res.redirect('/admin/operaciones');
    }

    return res.redirect(dispatchModuleUrl);
  });

  return router;
}
