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

async function runDelete(res, successPath, failurePath, action, successMessage, failureMessage) {
  try {
    await action();
    return res.redirect(redirectWithMessage(successPath, successMessage));
  } catch (error) {
    if (!isKnownDeleteConstraintError(error)) console.error(error);
    return res.redirect(redirectWithMessage(failurePath, failureMessage));
  }
}

async function findClientByPublicToken(publicToken) {
  const client = await prisma.dispatchClient.findFirst({
    where: { publicToken, isActive: true },
    include: {
      operationPoints: {
        where: { isActive: true },
        orderBy: { name: 'asc' }
      },
      services: {
        where: { isActive: true },
        orderBy: { name: 'asc' }
      }
    }
  });

  if (client) return client;

  const legacyOperationPoint = await prisma.dispatchOperationPoint.findFirst({
    where: { publicToken, isActive: true },
    include: {
      client: {
        include: {
          operationPoints: {
            where: { isActive: true },
            orderBy: { name: 'asc' }
          },
          services: {
            where: { isActive: true },
            orderBy: { name: 'asc' }
          }
        }
      }
    }
  });

  return legacyOperationPoint?.client?.isActive ? legacyOperationPoint.client : null;
}

async function findClientByLegacyOperationToken(publicToken) {
  const operationPoint = await prisma.dispatchOperationPoint.findFirst({
    where: { publicToken, isActive: true },
    include: { client: true }
  });

  return operationPoint?.client?.isActive ? operationPoint.client : null;
}

export function publicDispatchClientRouter() {
  const router = express.Router();

  router.post('/admin-delete/clientes/:clientId', requireOps, async (req, res) => {
    const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId }, select: { id: true } });
    if (!client) return res.status(404).send('Cliente no encontrado');

    return runDelete(
      res,
      '/admin/operaciones/clientes',
      '/admin/operaciones/clientes',
      () => prisma.dispatchClient.delete({ where: { id: client.id } }),
      'Cliente eliminado correctamente.',
      'No fue posible eliminar el cliente porque tiene dependencias operativas.'
    );
  });

  router.post('/admin-delete/clientes/:clientId/operaciones/:operationId', requireOps, async (req, res) => {
    const operation = await prisma.dispatchOperationPoint.findFirst({ where: { id: req.params.operationId, clientId: req.params.clientId }, select: { id: true } });
    if (!operation) return res.status(404).send('Operación no encontrada');

    return runDelete(
      res,
      clientOperationsPath(req.params.clientId),
      clientOperationsPath(req.params.clientId),
      () => prisma.dispatchOperationPoint.delete({ where: { id: operation.id } }),
      'Operación eliminada correctamente.',
      'No fue posible eliminar la operación porque tiene dependencias operativas.'
    );
  });

  router.post('/admin-delete/clientes/:clientId/servicios/:serviceId', requireOps, async (req, res) => {
    const service = await prisma.dispatchClientService.findFirst({ where: { id: req.params.serviceId, clientId: req.params.clientId }, select: { id: true } });
    if (!service) return res.status(404).send('Servicio no encontrado');

    return runDelete(
      res,
      clientOperationsPath(req.params.clientId),
      clientOperationsPath(req.params.clientId),
      () => prisma.dispatchClientService.delete({ where: { id: service.id } }),
      'Servicio eliminado correctamente.',
      'No fue posible eliminar el servicio porque tiene dependencias operativas.'
    );
  });

  router.post('/admin-delete/personal/:workerId', requireOps, async (req, res) => {
    const worker = await prisma.dispatchWorker.findFirst({ where: { id: req.params.workerId, source: 'MANUAL' }, select: { id: true } });
    if (!worker) return res.status(404).send('Auxiliar manual no encontrado');

    return runDelete(
      res,
      '/admin/operaciones/personal',
      '/admin/operaciones/personal',
      () => prisma.dispatchWorker.delete({ where: { id: worker.id } }),
      'Auxiliar manual eliminado correctamente.',
      'No fue posible eliminar el auxiliar porque tiene dependencias operativas.'
    );
  });

  router.get('/cliente/:publicToken', async (req, res) => {
    const client = await findClientByPublicToken(req.params.publicToken);
    if (!client) return res.status(404).send('Link no disponible');

    return res.render('publicDispatchRequest', {
      client,
      operationPoints: client.operationPoints,
      services: client.services,
      operationPoint: null,
      service: null,
      success: false
    });
  });

  router.post('/cliente/:publicToken', async (req, res) => {
    const client = await findClientByPublicToken(req.params.publicToken);
    if (!client) return res.status(404).send('Link no disponible');

    const operationPointId = normalizeString(req.body.operationPointId);
    const operationPoint = client.operationPoints.find((item) => item.id === operationPointId);
    if (!operationPoint) return res.status(400).send('Debes seleccionar una operación válida.');

    const serviceId = normalizeString(req.body.serviceId);
    const selectedService = client.services.find((item) => item.id === serviceId) || null;
    if (client.services.length && !selectedService) return res.status(400).send('Debes seleccionar un servicio válido.');

    const requiredWorkersRaw = Number(req.body.requiredWorkers);
    const serviceDate = normalizeString(req.body.serviceDate);
    if (!serviceDate || !Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) {
      return res.status(400).send('Debes ingresar fecha y cantidad válida de auxiliares.');
    }

    await prisma.dispatchServiceRequest.create({
      data: {
        operationPointId: operationPoint.id,
        clientName: client.name,
        operationPointName: operationPoint.name,
        cityName: operationPoint.cityName,
        address: operationPoint.address,
        serviceId: selectedService?.id || null,
        serviceName: selectedService?.name || null,
        serviceDate: new Date(serviceDate),
        startTime: normalizeString(req.body.startTime),
        endTime: normalizeString(req.body.endTime),
        requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)),
        notes: normalizeString(req.body.notes),
        requestedByName: normalizeString(req.body.requestedByName),
        requestedByPhone: normalizeString(req.body.requestedByPhone),
        requestedByEmail: normalizeString(req.body.requestedByEmail),
        source: 'PUBLIC_LINK',
        status: 'PENDING_ASSIGNMENT'
      }
    });

    return res.render('publicDispatchRequest', {
      client,
      operationPoints: client.operationPoints,
      services: client.services,
      operationPoint,
      service: selectedService,
      success: true
    });
  });

  router.get('/solicitud/:publicToken', async (req, res) => {
    const client = await findClientByLegacyOperationToken(req.params.publicToken);
    if (!client) return res.redirect(`/operaciones/cliente/${req.params.publicToken}`);
    return res.redirect(`/operaciones/cliente/${client.publicToken}`);
  });

  return router;
}
