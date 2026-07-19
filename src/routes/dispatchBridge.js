import express from 'express';
import { prisma } from '../lib/prisma.js';
import { dispatchAttendancePointConfigRouter } from './dispatchAttendancePointConfig.js';
import { dispatchBridgeRouter as dispatchBridgeCoreRouter } from './dispatchBridgeCore.js';

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
  const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch);
  return role === 'dev' || canAccessDispatch || isOpsUser(req);
}

function requireOps(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.redirect('/login');
  if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
  return next();
}

export function dispatchBridgeRouter() {
  const router = express.Router();
  router.use(
    '/clientes/:clientId/operaciones/:operationId/asistencia',
    requireOps,
    dispatchAttendancePointConfigRouter(prisma)
  );
  router.use(dispatchBridgeCoreRouter());
  return router;
}
