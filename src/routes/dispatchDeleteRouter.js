import express from 'express';
import { prisma } from '../lib/prisma.js';

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

function redirectWithMessage(path, message) {
  return `${path}?message=${encodeURIComponent(message)}`;
}

function clientOperationsPath(clientId) {
  return `/admin/operaciones/clientes/${clientId}/operaciones`;
}

function isKnownDeleteConstraintError(error) {
  return error?.code === 'P2003' || error?.code === 'P2014';
}

async function safeDelete(res, successPath, failurePath, action, successMessage, failureMessage) {
  try {
    await action();
    return res.redirect(redirectWithMessage(successPath, successMessage));
  } catch (error) {
    if (isKnownDeleteConstraintError(error)) {
      return res.redirect(redirectWithMessage(failurePath, failureMessage));
    }
    console.error(error);
    return res.redirect(redirectWithMessage(failurePath, failureMessage));
  }
}

export function dispatchDeleteRouter() {
  const router = express.Router();

  router.post('/clientes/:clientId/eliminar', requireOps, async (req, res) => {
    const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId }, select: { id: true } });
    if (!client) return res.status(404).send('Cliente no encontrado');

    return safeDelete(
      res,
      '/admin/operaciones/clientes',
      '/admin/operaciones/clientes',
      () => prisma.dispatchClient.delete({ where: { id: client.id } }),
      'Cliente eliminado correctamente.',
      'No fue posible eliminar el cliente porque tiene dependencias operativas.'
    );
  });

  router.post('/clientes/:clientId/operaciones/:operationId/eliminar', requireOps, async (req, res) => {
    const operation = await prisma.dispatchOperationPoint.findFirst({
      where: { id: req.params.operationId, clientId: req.params.clientId },
      select: { id: true }
    });
    if (!operation) return res.status(404).send('Operación no encontrada');

    return safeDelete(
      res,
      clientOperationsPath(req.params.clientId),
      clientOperationsPath(req.params.clientId),
      () => prisma.dispatchOperationPoint.delete({ where: { id: operation.id } }),
      'Operación eliminada correctamente.',
      'No fue posible eliminar la operación porque tiene dependencias operativas.'
    );
  });

  router.post('/clientes/:clientId/servicios/:serviceId/eliminar', requireOps, async (req, res) => {
    const service = await prisma.dispatchClientService.findFirst({
      where: { id: req.params.serviceId, clientId: req.params.clientId },
      select: { id: true }
    });
    if (!service) return res.status(404).send('Servicio no encontrado');

    return safeDelete(
      res,
      clientOperationsPath(req.params.clientId),
      clientOperationsPath(req.params.clientId),
      () => prisma.dispatchClientService.delete({ where: { id: service.id } }),
      'Servicio eliminado correctamente.',
      'No fue posible eliminar el servicio porque tiene dependencias operativas.'
    );
  });

  router.post('/personal/:workerId/eliminar', requireOps, async (req, res) => {
    const worker = await prisma.dispatchWorker.findFirst({
      where: { id: req.params.workerId, source: 'MANUAL' },
      select: { id: true }
    });
    if (!worker) return res.status(404).send('Auxiliar manual no encontrado');

    return safeDelete(
      res,
      '/admin/operaciones/personal',
      '/admin/operaciones/personal',
      () => prisma.dispatchWorker.delete({ where: { id: worker.id } }),
      'Auxiliar manual eliminado correctamente.',
      'No fue posible eliminar el auxiliar porque tiene dependencias operativas.'
    );
  });

  return router;
}
