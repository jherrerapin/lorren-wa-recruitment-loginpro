import express from 'express';
import { prisma } from '../lib/prisma.js';
import { upsertDispatchWorkerFromCandidate } from '../services/dispatchWorkerSync.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeText(value) {
  return normalizeString(value)
    ?.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase() || '';
}

function isBogotaSiberiaName(cityName) {
  const normalized = normalizeText(cityName);
  return normalized === 'bogota' || normalized === 'bogota d.c.' || normalized === 'bogota dc' || normalized === 'siberia';
}

async function resolveCompatibleOperationalCityIds(operationalCityId) {
  if (!operationalCityId) return [];

  const selectedCity = await prisma.city.findUnique({
    where: { id: operationalCityId },
    select: { id: true, name: true }
  });

  if (!selectedCity) return [operationalCityId];
  if (!isBogotaSiberiaName(selectedCity.name)) return [selectedCity.id];

  const cities = await prisma.city.findMany({ select: { id: true, name: true } });
  const compatibleIds = cities
    .filter((city) => isBogotaSiberiaName(city.name))
    .map((city) => city.id);

  return compatibleIds.length ? compatibleIds : [selectedCity.id];
}

function buildOperationalCityFilter(compatibleOperationalCityIds) {
  if (!compatibleOperationalCityIds.length) return {};
  return { cities: { some: { cityId: { in: compatibleOperationalCityIds } } } };
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



async function recalculateServiceRequestStatus(serviceRequestId) {
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { id: true, requiredWorkers: true }
  });
  if (!serviceRequest) return;

  const assignedCount = await prisma.dispatchAssignment.count({ where: { serviceRequestId } });
  let status = 'PENDING_ASSIGNMENT';
  if (assignedCount >= serviceRequest.requiredWorkers) status = 'ASSIGNMENT_COMPLETE';
  else if (assignedCount > 0) status = 'ASSIGNMENT_PARTIAL';

  await prisma.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
}

function requireDev(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (role !== 'dev') return res.status(403).send('Solo DEV');
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

  router.get('/asignaciones', requireOps, async (req, res) => {
    const q = normalizeString(req.query.q);
    const operationalCityId = normalizeString(req.query.operationalCityId);
    const vacancyId = normalizeString(req.query.vacancyId);
    const transportMode = normalizeString(req.query.transportMode);
    const locality = normalizeString(req.query.locality);
    const status = normalizeString(req.query.status);
    const compatibleOperationalCityIds = await resolveCompatibleOperationalCityIds(operationalCityId);
    const operationalCityFilter = buildOperationalCityFilter(compatibleOperationalCityIds);

    const workers = await prisma.dispatchWorker.findMany({
      where: {
        ...(q ? {
          OR: [
            { fullName: { contains: q, mode: 'insensitive' } },
            { documentNumber: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q, mode: 'insensitive' } }
          ]
        } : {}),
        ...operationalCityFilter,
        ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}),
        ...(transportMode ? { transportMode } : {}),
        ...(locality ? { residenceLocality: locality } : {}),
        ...(status ? { operationalStatus: status } : {})
      },
      include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const localityWhere = {
      ...operationalCityFilter,
      ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}),
      ...(transportMode ? { transportMode } : {}),
      ...(status ? { operationalStatus: status } : {})
    };

    const serviceRequestId = normalizeString(req.query.serviceRequestId);

    const [cities, vacancies, transportModeRows, localityRows, serviceRequests] = await Promise.all([
      prisma.city.findMany({ orderBy: { name: 'asc' } }),
      prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } }),
      prisma.dispatchWorker.findMany({ select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }),
      prisma.dispatchWorker.findMany({
        where: localityWhere,
        select: { residenceLocality: true },
        distinct: ['residenceLocality'],
        orderBy: { residenceLocality: 'asc' }
      }),
      prisma.dispatchServiceRequest.findMany({
        include: { assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }]
      })
    ]);

    const selectedServiceRequest = serviceRequestId
      ? serviceRequests.find((item) => item.id === serviceRequestId) || null
      : serviceRequests[0] || null;

    return res.render('operacionesAsignaciones', {
      workers,
      cities,
      vacancies,
      serviceRequests,
      selectedServiceRequest,
      selectedServiceRequestId: selectedServiceRequest?.id || '',
      message: normalizeString(req.query.message),
      filters: {
        q: q || '',
        operationalCityId: operationalCityId || '',
        vacancyId: vacancyId || '',
        transportMode: transportMode || '',
        locality: locality || '',
        status: status || ''
      },
      transportModes: transportModeRows.map((row) => row.transportMode).filter(Boolean),
      localities: localityRows.map((row) => row.residenceLocality).filter(Boolean),
      role: req.session?.userRole || req.userRole,
      canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
    });
  });

  router.post('/asignaciones/solicitudes', requireOps, async (req, res) => {
    const clientName = normalizeString(req.body.clientName);
    const serviceDateRaw = normalizeString(req.body.serviceDate);
    const requiredWorkersRaw = Number(req.body.requiredWorkers);

    if (!clientName || !serviceDateRaw || !Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) {
      return res.status(400).send('Datos inválidos para crear solicitud operativa');
    }

    const created = await prisma.dispatchServiceRequest.create({
      data: {
        clientName,
        operationPointName: normalizeString(req.body.operationPointName),
        cityName: normalizeString(req.body.cityName),
        address: normalizeString(req.body.address),
        serviceDate: new Date(serviceDateRaw),
        startTime: normalizeString(req.body.startTime),
        endTime: normalizeString(req.body.endTime),
        requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)),
        notes: normalizeString(req.body.notes),
        status: 'PENDING_ASSIGNMENT',
        createdByUsername: req.session?.username || req.username || null
      }
    });

    return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${created.id}`);
  });

  router.post('/asignaciones/assign', requireOps, async (req, res) => {
    const serviceRequestId = normalizeString(req.body.serviceRequestId);
    const workerId = normalizeString(req.body.workerId);
    if (!serviceRequestId || !workerId) return res.status(400).send('serviceRequestId y workerId son requeridos');

    const [serviceRequest, worker] = await Promise.all([
      prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true } }),
      prisma.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true } })
    ]);

    if (!serviceRequest || !worker) return res.status(404).send('Solicitud o auxiliar no encontrado');

    const exists = await prisma.dispatchAssignment.findUnique({ where: { serviceRequestId_workerId: { serviceRequestId, workerId } } });
    if (exists) {
      return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}&message=${encodeURIComponent('El auxiliar ya estaba asignado.')}`);
    }

    await prisma.dispatchAssignment.create({
      data: {
        serviceRequestId,
        workerId,
        status: 'ASSIGNED',
        createdByUsername: req.session?.username || req.username || null
      }
    });

    await recalculateServiceRequestStatus(serviceRequestId);
    return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}`);
  });

  router.post('/asignaciones/unassign', requireOps, async (req, res) => {
    const assignmentId = normalizeString(req.body.assignmentId);
    const serviceRequestId = normalizeString(req.body.serviceRequestId);
    if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos');

    await prisma.dispatchAssignment.delete({ where: { id: assignmentId } });
    await recalculateServiceRequestStatus(serviceRequestId);
    return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}`);
  });


  router.get('/personal', requireOps, async (req, res) => {
    const operationalCityId = normalizeString(req.query.operationalCityId);
    const vacancyId = normalizeString(req.query.vacancyId);
    const status = normalizeString(req.query.status);

    const workers = await prisma.dispatchWorker.findMany({
      where: {
        ...(status ? { operationalStatus: status } : {}),
        ...(operationalCityId ? { cities: { some: { cityId: operationalCityId } } } : {}),
        ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {})
      },
      include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const cities = await prisma.city.findMany({ orderBy: { name: 'asc' } });
    const vacancies = await prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } });

    return res.render('operacionesPersonal', {
      pageTitle: 'Personal operativo',
      subtitle: 'Equipo disponible para asignación.',
      activeSection: 'personal',
      workers,
      cities,
      vacancies,
      filters: { operationalCityId: operationalCityId || '', vacancyId: vacancyId || '', status: status || '' },
      message: normalizeString(req.query.message),
      role: req.userRole,
      canAccessDispatch: req.canAccessDispatch
    });
  });

  router.post('/sync-contratados', requireOps, requireDev, async (_req, res) => {
    const registered = await prisma.candidate.findMany({ where: { status: 'REGISTRADO' }, select: { id: true } });
    for (const candidate of registered) await upsertDispatchWorkerFromCandidate(prisma, candidate.id);
    return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent(`Modo prueba: sincronización completada con ${registered.length} candidatos registrados procesados.`)}`);
  });

  router.get('/novedades', requireOps, (_req, res) => {
    return renderOperationsDashboard(res, {
      pageTitle: 'Novedades operativas',
      activeSection: 'novedades'
    });
  });

  return router;
}
