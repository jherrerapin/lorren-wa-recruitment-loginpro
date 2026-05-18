import express from 'express';
import { prisma } from '../lib/prisma.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

async function findClientByPublicToken(publicToken) {
  const client = await prisma.dispatchClient.findFirst({
    where: { publicToken, isActive: true },
    include: {
      operationPoints: {
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

  router.get('/cliente/:publicToken', async (req, res) => {
    const client = await findClientByPublicToken(req.params.publicToken);
    if (!client) return res.status(404).send('Link no disponible');

    return res.render('publicDispatchRequest', {
      client,
      operationPoints: client.operationPoints,
      operationPoint: null,
      success: false
    });
  });

  router.post('/cliente/:publicToken', async (req, res) => {
    const client = await findClientByPublicToken(req.params.publicToken);
    if (!client) return res.status(404).send('Link no disponible');

    const operationPointId = normalizeString(req.body.operationPointId);
    const operationPoint = client.operationPoints.find((item) => item.id === operationPointId);
    if (!operationPoint) return res.status(400).send('Debes seleccionar una operación válida.');

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
      operationPoint,
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
