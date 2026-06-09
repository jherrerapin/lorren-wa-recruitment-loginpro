import express from 'express';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';

const TIME_HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const GROUP_PATTERN = /\s*·\s*Grupo\s+(GRP-[A-Z0-9-]+)/i;

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

function normalizeRequiredTime(value, label) {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(`${label} es obligatorio en cada horario.`);
  if (!TIME_HH_MM_PATTERN.test(normalized)) throw new Error(`${label} invalido. Usa formato HH:mm.`);
  return normalized;
}

function normalizeOptionalTime(value, label) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (!TIME_HH_MM_PATTERN.test(normalized)) throw new Error(`${label} invalido. Usa formato HH:mm.`);
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
    const startTime = normalizeRequiredTime(starts[index] ?? null, 'Hora inicio');
    const endTime = normalizeOptionalTime(ends[index] ?? null, 'Hora fin');

    if (!requiredWorkers) throw new Error('Debes ingresar una cantidad valida de auxiliares en cada horario.');
    blocks.push({ requiredWorkers, startTime, endTime });
  }

  if (!blocks.length) throw new Error('Debes ingresar al menos un horario con cantidad valida de auxiliares.');
  return blocks;
}

function extractGroupCode(request) {
  const match = normalizeString(request?.serviceName)?.match(GROUP_PATTERN);
  return match?.[1] || null;
}

function cleanServiceName(value) {
  return normalizeString(value)?.replace(GROUP_PATTERN, '').trim() || null;
}

function buildRequestGroupCode(blocks) {
  if (blocks.length <= 1) return null;
  return `GRP-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
}

function serviceNameWithGroup(service, groupCode) {
  const baseName = service?.name || null;
  if (!groupCode) return baseName;
  return `${baseName || 'Servicio'} · Grupo ${groupCode}`;
}

function serviceData(service, groupCode = null) {
  return { serviceId: service?.id || null, serviceName: serviceNameWithGroup(service, groupCode) };
}

function createdSummary(blocks, groupCode = null) {
  const total = blocks.reduce((sum, block) => sum + block.requiredWorkers, 0);
  const base = blocks.length === 1
    ? `1 bloque creado para ${total} auxiliar${total !== 1 ? 'es' : ''}`
    : `${blocks.length} bloques creados para ${total} auxiliares en total`;
  return groupCode ? `${base}. Grupo operativo ${groupCode}` : base;
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

function sortRequestBlocks(requests = []) {
  return [...requests].sort((a, b) => {
    const dateA = new Date(a.serviceDate || 0).getTime();
    const dateB = new Date(b.serviceDate || 0).getTime();
    if (dateA !== dateB) return dateA - dateB;
    return String(a.startTime || '').localeCompare(String(b.startTime || ''), 'es');
  });
}

function serviceDateKey(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function serviceStartDateTime(request) {
  const date = serviceDateKey(request?.serviceDate);
  if (!date) return null;
  const time = request?.startTime || '00:00';
  return new Date(`${date}T${time}:00-05:00`);
}

function getPublicRequestKey(requests = []) {
  const first = requests[0];
  return extractGroupCode(first) || first?.id || null;
}

function getRequestEditLock(requests = []) {
  const hasAssignments = requests.some((request) => (request.assignments || []).length > 0);
  if (hasAssignments) return { editable: false, reason: 'La solicitud ya tiene asignaciones registradas por Operaciones / Despacho.' };

  const now = new Date();
  const hasStarted = requests.some((request) => {
    const start = serviceStartDateTime(request);
    return start && start <= now;
  });
  if (hasStarted) return { editable: false, reason: 'La fecha y hora de inicio del servicio ya pasaron.' };

  return { editable: true, reason: null };
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

async function loadPublicRequestContext(publicToken, requestKey) {
  const client = await loadPublicClient(publicToken);
  if (!client) return null;
  const operationPointIds = client.operationPoints.map((operationPoint) => operationPoint.id);
  if (!operationPointIds.length) return { client, requests: [], requestKey };

  const requests = await prisma.dispatchServiceRequest.findMany({
    where: {
      operationPointId: { in: operationPointIds },
      OR: [
        { id: requestKey },
        { serviceName: { contains: `Grupo ${requestKey}` } }
      ]
    },
    include: {
      service: true,
      assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } }
    },
    orderBy: [{ serviceDate: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }]
  });

  return { client, requests: sortRequestBlocks(requests), requestKey };
}

function buildPublicRequestViewModel(client, requests, requestKey) {
  const sortedRequests = sortRequestBlocks(requests);
  const primary = sortedRequests[0] || null;
  const groupCode = extractGroupCode(primary);
  const editLock = getRequestEditLock(sortedRequests);
  const totalRequired = sortedRequests.reduce((sum, request) => sum + (Number(request.requiredWorkers) || 0), 0);
  const operationPoint = primary ? client.operationPoints.find((item) => item.id === primary.operationPointId) || null : null;
  const selectedService = primary?.serviceId ? client.services.find((item) => item.id === primary.serviceId) || null : null;

  return {
    requestKey: groupCode || requestKey || primary?.id,
    groupCode,
    primary,
    requests: sortedRequests,
    operationPoint,
    selectedService,
    serviceName: cleanServiceName(primary?.serviceName) || primary?.service?.name || selectedService?.name || 'Sin servicio',
    totalRequired,
    editable: editLock.editable,
    editBlockedReason: editLock.reason,
    viewUrl: primary ? `/operaciones/cliente/${client.publicToken}/solicitudes/${encodeURIComponent(groupCode || requestKey || primary.id)}` : null,
    editUrl: primary ? `/operaciones/cliente/${client.publicToken}/solicitudes/${encodeURIComponent(groupCode || requestKey || primary.id)}/editar` : null
  };
}

function validatePublicContact(body) {
  const requestedByName = normalizeString(body.requestedByName);
  const requestedByPhone = normalizeString(body.requestedByPhone);
  const requestedByEmail = normalizeString(body.requestedByEmail);
  if (!requestedByName || !requestedByPhone || !requestedByEmail) {
    throw new Error('Nombre, teléfono y correo de quien solicita son obligatorios.');
  }
  return { requestedByName, requestedByPhone, requestedByEmail };
}

async function updatePublicRequests(client, currentRequests, body) {
  const operationPoint = client.operationPoints.find((item) => item.id === normalizeString(body.operationPointId));
  if (!operationPoint) throw new Error('Debes seleccionar una operación válida.');
  const selectedService = client.services.find((item) => item.id === normalizeString(body.serviceId)) || null;
  if (client.services.length && !selectedService) throw new Error('Debes seleccionar un servicio válido.');
  const serviceDate = normalizeString(body.serviceDate);
  if (!serviceDate) throw new Error('Debes ingresar la fecha del servicio.');
  const contact = validatePublicContact(body);
  const blocks = buildTimeBlocks(body);
  const existingGroupCode = extractGroupCode(currentRequests[0]);
  const nextGroupCode = blocks.length > 1 ? (existingGroupCode || buildRequestGroupCode(blocks)) : null;
  const existingRequests = sortRequestBlocks(currentRequests);
  const baseData = {
    operationPointId: operationPoint.id,
    clientName: client.name,
    operationPointName: operationPoint.name,
    cityName: operationPoint.cityName || client.cityName,
    address: operationPoint.address,
    ...serviceData(selectedService, nextGroupCode),
    serviceDate: new Date(serviceDate),
    notes: normalizeString(body.notes),
    ...contact,
    source: 'PUBLIC_LINK',
    status: 'PENDING_ASSIGNMENT'
  };

  await prisma.$transaction(async (tx) => {
    for (const [index, block] of blocks.entries()) {
      const existing = existingRequests[index];
      if (existing) {
        await tx.dispatchServiceRequest.update({ where: { id: existing.id }, data: { ...baseData, ...block } });
      } else {
        await tx.dispatchServiceRequest.create({ data: { ...baseData, ...block } });
      }
    }

    const extraRequests = existingRequests.slice(blocks.length);
    for (const request of extraRequests) {
      await tx.dispatchServiceRequest.delete({ where: { id: request.id } });
    }
  });

  const updatedKey = nextGroupCode || existingRequests[0]?.id;
  return { updatedKey, operationPoint, selectedService };
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

    const groupCode = buildRequestGroupCode(blocks);
    await createRequests({
      operationPointId: operationPoint.id,
      clientName: client.name,
      operationPointName: operationPoint.name,
      cityName: operationPoint.cityName || client.cityName,
      address: operationPoint.address || normalizeString(req.body.address),
      ...serviceData(selectedService, groupCode),
      serviceDate: new Date(serviceDate),
      notes: normalizeString(req.body.notes),
      status: 'PENDING_ASSIGNMENT',
      source: 'INTERNAL',
      createdByUsername: req.session?.username || req.username || null
    }, blocks);

    return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent(`Solicitud creada: ${createdSummary(blocks, groupCode)}.`)}`);
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

    let contact;
    try { contact = validatePublicContact(req.body); } catch (error) { return res.status(400).send(error.message); }

    let blocks;
    try { blocks = buildTimeBlocks(req.body); } catch (error) { return res.status(400).send(error.message); }

    const groupCode = buildRequestGroupCode(blocks);
    const createdRequests = await createRequests({
      operationPointId: operationPoint.id,
      clientName: client.name,
      operationPointName: operationPoint.name,
      cityName: operationPoint.cityName || client.cityName,
      address: operationPoint.address,
      ...serviceData(selectedService, groupCode),
      serviceDate: new Date(serviceDate),
      notes: normalizeString(req.body.notes),
      ...contact,
      source: 'PUBLIC_LINK',
      status: 'PENDING_ASSIGNMENT'
    }, blocks);

    const requestKey = groupCode || createdRequests[0]?.id;
    const viewUrl = requestKey ? `/operaciones/cliente/${client.publicToken}/solicitudes/${encodeURIComponent(requestKey)}` : null;

    return res.render('publicDispatchRequest', {
      client,
      operationPoints: client.operationPoints,
      services: client.services,
      operationPoint,
      service: selectedService,
      success: true,
      createdSummary: createdSummary(blocks, groupCode),
      requestViewUrl: viewUrl
    });
  });

  router.get('/operaciones/cliente/:publicToken/solicitudes/:requestKey', async (req, res) => {
    const context = await loadPublicRequestContext(req.params.publicToken, req.params.requestKey);
    if (!context?.client) return res.status(404).send('Link no disponible');
    if (!context.requests.length) return res.status(404).send('Solicitud no encontrada');
    return res.render('publicDispatchRequestReview', {
      mode: 'view',
      client: context.client,
      operationPoints: context.client.operationPoints,
      services: context.client.services,
      requestView: buildPublicRequestViewModel(context.client, context.requests, context.requestKey),
      message: normalizeString(req.query.message),
      error: null
    });
  });

  router.get('/operaciones/cliente/:publicToken/solicitudes/:requestKey/editar', async (req, res) => {
    const context = await loadPublicRequestContext(req.params.publicToken, req.params.requestKey);
    if (!context?.client) return res.status(404).send('Link no disponible');
    if (!context.requests.length) return res.status(404).send('Solicitud no encontrada');
    const requestView = buildPublicRequestViewModel(context.client, context.requests, context.requestKey);
    if (!requestView.editable) {
      return res.redirect(`${requestView.viewUrl}?message=${encodeURIComponent(requestView.editBlockedReason || 'La solicitud ya no puede editarse.')}`);
    }
    return res.render('publicDispatchRequestReview', {
      mode: 'edit',
      client: context.client,
      operationPoints: context.client.operationPoints,
      services: context.client.services,
      requestView,
      message: null,
      error: normalizeString(req.query.error)
    });
  });

  router.post('/operaciones/cliente/:publicToken/solicitudes/:requestKey/editar', async (req, res) => {
    const context = await loadPublicRequestContext(req.params.publicToken, req.params.requestKey);
    if (!context?.client) return res.status(404).send('Link no disponible');
    if (!context.requests.length) return res.status(404).send('Solicitud no encontrada');
    const requestView = buildPublicRequestViewModel(context.client, context.requests, context.requestKey);
    if (!requestView.editable) {
      return res.redirect(`${requestView.viewUrl}?message=${encodeURIComponent(requestView.editBlockedReason || 'La solicitud ya no puede editarse.')}`);
    }

    try {
      const result = await updatePublicRequests(context.client, context.requests, req.body);
      return res.redirect(`/operaciones/cliente/${context.client.publicToken}/solicitudes/${encodeURIComponent(result.updatedKey)}?message=${encodeURIComponent('Solicitud actualizada correctamente.')}`);
    } catch (error) {
      return res.redirect(`${requestView.editUrl}?error=${encodeURIComponent(error.message || 'No fue posible actualizar la solicitud.')}`);
    }
  });

  return router;
}
