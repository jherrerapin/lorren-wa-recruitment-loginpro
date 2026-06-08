import express from 'express';
import { prisma } from '../lib/prisma.js';

const TIME_HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function normalizeOptionalTime(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (!TIME_HH_MM_PATTERN.test(normalized)) throw new Error('Horario invalido. Usa formato HH:mm.');
  return normalized;
}

function normalizePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.max(1, Math.trunc(parsed));
}

function buildTimeBlocks(body = {}) {
  const quantities = asArray(body.requiredWorkers);
  const starts = asArray(body.startTime);
  const ends = asArray(body.endTime);
  const count = Math.max(quantities.length, starts.length, ends.length, 1);
  const blocks = [];

  for (let index = 0; index < count; index += 1) {
    const requiredWorkers = normalizePositiveInt(quantities[index] ?? quantities[0]);
    const startTime = normalizeOptionalTime(starts[index] ?? null);
    const endTime = normalizeOptionalTime(ends[index] ?? null);
    const hasAnyValue = Boolean(quantities[index] || starts[index] || ends[index]);
    if (!hasAnyValue && count > 1) continue;
    if (!requiredWorkers) throw new Error('Debes ingresar una cantidad valida de auxiliares en cada horario.');
    blocks.push({ requiredWorkers, startTime, endTime });
  }

  if (!blocks.length) throw new Error('Debes ingresar al menos un horario con cantidad valida de auxiliares.');
  return blocks;
}

function serviceData(service) {
  return { serviceId: service?.id || null, serviceName: service?.name || null };
}

function createdSummary(blocks) {
  const total = blocks.reduce((sum, block) => sum + block.requiredWorkers, 0);
  return blocks.length === 1
    ? `1 bloque creado para ${total} auxiliar${total !== 1 ? 'es' : ''}`
    : `${blocks.length} bloques creados para ${total} auxiliares en total`;
}

function canUseOps(req) {
  const role = req.session?.userRole || req.userRole;
  const dispatchAccess = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch);
  const username = normalizeString(req.session?.username || req.username);
  return role === 'dev' || dispatchAccess || Boolean(username?.startsWith('operaciones-despacho'));
}

function requireOps(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.redirect('/login');
  if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
  return next();
}

async function createRequests(baseData, blocks) {
  return prisma.$transaction(blocks.map((block) => prisma.dispatchServiceRequest.create({
    data: { ...baseData, ...block }
  })));
}

async function loadPublicClient(publicToken) {
  return prisma.dispatchClient.findFirst({
    where: { publicToken, isActive: true },
    include: {
      operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } },
      services: { where: { isActive: true }, orderBy: { name: 'asc' } }
    }
  });
}

export function dispatchMultiShiftRequestsRouter() {
  const router = express.Router();

  router.post('/admin/operaciones/solicitudes', requireOps, async (req, res) => {
    const clientId = normalizeString(req.body.clientId);
    const operationPointId = normalizeString(req.body.operationPointId);
    const serviceId = normalizeString(req.body.serviceId);
    const serviceDate = normalizeString(req.body.serviceDate);
    if (!clientId || !operationPointId || !serviceDate) return res.status(400).send('Selecciona cliente, punto de operación y fecha.');

    let blocks;
    try { blocks = buildTimeBlocks(req.body); } catch (error) { return res.status(400).send(error.message); }

    const client = await prisma.dispatchClient.findFirst({
      where: { id: clientId, isActive: true },
      include: { operationPoints: { where: { isActive: true } }, services: { where: { isActive: true } } }
    });
    if (!client) return res.status(404).send('Cliente no encontrado o inactivo.');
    const operationPoint = client.operationPoints.find((item) => item.id === operationPointId);
    if (!operationPoint) return res.status(400).send('Debes seleccionar una operación válida para el cliente.');
    const selectedService = serviceId ? client.services.find((item) => item.id === serviceId) || null : null;
    if (client.services.length && !selectedService) return res.status(400).send('Debes seleccionar un servicio válido para el cliente.');

    await createRequests({
      operationPointId: operationPoint.id,
      clientName: client.name,
      operationPointName: operationPoint.name,
      cityName: operationPoint.cityName || client.cityName,
      address: operationPoint.address || normalizeString(req.body.address),
      ...serviceData(selectedService),
      serviceDate: new Date(serviceDate),
      notes: normalizeString(req.body.notes),
      status: 'PENDING_ASSIGNMENT',
      source: 'INTERNAL',
      createdByUsername: req.session?.username || req.username || null
    }, blocks);

    return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent(`Solicitud creada: ${createdSummary(blocks)}.`)}`);
  });

  router.post('/operaciones/cliente/:publicToken', async (req, res) => {
    const client = await loadPublicClient(req.params.publicToken);
    if (!client) return res.status(404).send('Link no disponible');

    const operationPoint = client.operationPoints.find((item) => item.id === normalizeString(req.body.operationPointId));
    if (!operationPoint) return res.status(400).send('Debes seleccionar una operación válida.');
    const selectedService = client.services.find((item) => item.id === normalizeString(req.body.serviceId)) || null;
    if (client.services.length && !selectedService) return res.status(400).send('Debes seleccionar un servicio válido.');
    const serviceDate = normalizeString(req.body.serviceDate);
    if (!serviceDate) return res.status(400).send('Debes ingresar la fecha del servicio.');

    let blocks;
    try { blocks = buildTimeBlocks(req.body); } catch (error) { return res.status(400).send(error.message); }

    await createRequests({
      operationPointId: operationPoint.id,
      clientName: client.name,
      operationPointName: operationPoint.name,
      cityName: operationPoint.cityName || client.cityName,
      address: operationPoint.address,
      ...serviceData(selectedService),
      serviceDate: new Date(serviceDate),
      notes: normalizeString(req.body.notes),
      requestedByName: normalizeString(req.body.requestedByName),
      requestedByPhone: normalizeString(req.body.requestedByPhone),
      requestedByEmail: normalizeString(req.body.requestedByEmail),
      source: 'PUBLIC_LINK',
      status: 'PENDING_ASSIGNMENT'
    }, blocks);

    return res.render('publicDispatchRequest', {
      client,
      operationPoints: client.operationPoints,
      services: client.services,
      operationPoint,
      service: selectedService,
      success: true,
      createdSummary: createdSummary(blocks)
    });
  });

  return router;
}
