import express from 'express';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const EDITABLE_REQUEST_STATUSES = new Set([
  'PENDING_ASSIGNMENT',
  'ASSIGNMENT_PARTIAL',
  'PENDING_CONFIRMATION',
  'ASSIGNMENT_COMPLETE',
  'CANCELLED'
]);

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

function serviceRequestServiceData(service) {
  return { serviceId: service?.id || null, serviceName: service?.name || null };
}

async function loadActiveClientsForServiceRequestForm(prisma) {
  return prisma.dispatchClient.findMany({
    where: { isActive: true },
    include: {
      operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } },
      services: { where: { isActive: true }, orderBy: { name: 'asc' } }
    },
    orderBy: { name: 'asc' }
  });
}

async function recalculateServiceRequestStatus(prisma, serviceRequestId) {
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { id: true, requiredWorkers: true, status: true }
  });
  if (!serviceRequest || serviceRequest.status === 'CANCELLED') return null;

  const [activeCount, confirmedCount] = await Promise.all([
    prisma.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }),
    prisma.dispatchAssignment.count({ where: { serviceRequestId, status: CONFIRMED_ASSIGNMENT_STATUS } })
  ]);

  let status = 'PENDING_ASSIGNMENT';
  if (confirmedCount >= serviceRequest.requiredWorkers) status = 'ASSIGNMENT_COMPLETE';
  else if (activeCount >= serviceRequest.requiredWorkers) status = 'PENDING_CONFIRMATION';
  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';

  await prisma.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
  return { status, activeCount, confirmedCount, requiredWorkers: serviceRequest.requiredWorkers };
}

async function resolveClientSelection(prisma, body) {
  const clientId = normalizeString(body.clientId);
  const operationPointId = normalizeString(body.operationPointId);
  const serviceId = normalizeString(body.serviceId);

  if (!clientId || !operationPointId) {
    throw new Error('Debes seleccionar cliente y operación desde las listas desplegables.');
  }

  const client = await prisma.dispatchClient.findFirst({
    where: { id: clientId, isActive: true },
    include: {
      operationPoints: { where: { isActive: true } },
      services: { where: { isActive: true } }
    }
  });
  if (!client) throw new Error('Cliente no encontrado o inactivo.');

  const operationPoint = client.operationPoints.find((item) => item.id === operationPointId);
  if (!operationPoint) throw new Error('La operación seleccionada no pertenece al cliente o está inactiva.');

  const selectedService = serviceId ? client.services.find((item) => item.id === serviceId) || null : null;
  if (client.services.length && !selectedService) throw new Error('Debes seleccionar un servicio válido para el cliente.');

  return { client, operationPoint, selectedService };
}

export function dispatchServiceRequestEditRouter(prisma) {
  const router = express.Router();

  router.get('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => {
    const [serviceRequest, clients] = await Promise.all([
      prisma.dispatchServiceRequest.findUnique({
        where: { id: req.params.id },
        include: {
          service: true,
          operationPoint: { include: { client: true } }
        }
      }),
      loadActiveClientsForServiceRequestForm(prisma)
    ]);

    if (!serviceRequest) return res.status(404).send('Solicitud no encontrada');
    return res.render('operacionesSolicitudEditar', {
      serviceRequest,
      clients,
      error: normalizeString(req.query.error),
      role: req.session?.userRole || req.userRole
    });
  });

  router.post('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => {
    const requiredWorkersRaw = Number(req.body.requiredWorkers);
    const serviceDateRaw = normalizeString(req.body.serviceDate);
    const requestedStatus = normalizeString(req.body.status) || 'PENDING_ASSIGNMENT';

    if (!serviceDateRaw || !Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) {
      return res.redirect(`/admin/operaciones/asignaciones/solicitudes/${req.params.id}/editar?error=${encodeURIComponent('Debes ingresar fecha y cantidad válida de auxiliares.')}`);
    }

    if (!EDITABLE_REQUEST_STATUSES.has(requestedStatus)) {
      return res.redirect(`/admin/operaciones/asignaciones/solicitudes/${req.params.id}/editar?error=${encodeURIComponent('Estado de solicitud no válido.')}`);
    }

    try {
      const { client, operationPoint, selectedService } = await resolveClientSelection(prisma, req.body);
      await prisma.dispatchServiceRequest.update({
        where: { id: req.params.id },
        data: {
          operationPointId: operationPoint.id,
          clientName: client.name,
          operationPointName: operationPoint.name,
          cityName: operationPoint.cityName || client.cityName,
          address: operationPoint.address,
          ...serviceRequestServiceData(selectedService),
          serviceDate: new Date(serviceDateRaw),
          startTime: normalizeString(req.body.startTime),
          endTime: normalizeString(req.body.endTime),
          requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)),
          notes: normalizeString(req.body.notes),
          status: requestedStatus
        }
      });

      if (requestedStatus !== 'CANCELLED') await recalculateServiceRequestStatus(prisma, req.params.id);
      return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${req.params.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No fue posible actualizar la solicitud.';
      return res.redirect(`/admin/operaciones/asignaciones/solicitudes/${req.params.id}/editar?error=${encodeURIComponent(message)}`);
    }
  });

  return router;
}
