import express from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { loadUnifiedCityOptions, resolveEquivalentCityIds } from '../services/cityOptions.js';
import { normalizeTransportMode } from '../services/transportMode.js';

const workerCvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const ALLOWED_WORKER_CV_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const TIME_HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeDispatchContractType(value) {
  const normalized = normalizeString(value);
  return ['DIRECTO', 'CONTRATISTA'].includes(normalized) ? normalized : 'DIRECTO';
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeString(item)).filter(Boolean);
  const single = normalizeString(value);
  return single ? [single] : [];
}

function normalizeOptionalTime(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (!TIME_HH_MM_PATTERN.test(normalized)) {
    throw new Error('Horario invalido. Usa formato HH:mm.');
  }
  return normalized;
}

function setNoStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
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
  setNoStore(res);
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

function buildWorkerData(body) {
  return {
    fullName: normalizeString(body.fullName),
    phone: normalizeString(body.phone),
    documentType: normalizeString(body.documentType),
    documentNumber: normalizeString(body.documentNumber),
    residenceCity: normalizeString(body.residenceCity),
    residenceLocality: normalizeString(body.residenceLocality),
    transportMode: normalizeTransportMode(body.transportMode),
    contractType: normalizeDispatchContractType(body.contractType),
    operationalStatus: normalizeString(body.operationalStatus) || 'ACTIVE',
    notes: normalizeString(body.notes)
  };
}

function buildClientData(body) {
  return {
    name: normalizeString(body.name),
    nit: normalizeString(body.nit),
    cityName: normalizeString(body.cityName),
    contactName: normalizeString(body.contactName),
    contactPhone: normalizeString(body.contactPhone),
    contactEmail: normalizeString(body.contactEmail),
    notes: normalizeString(body.notes),
    isActive: normalizeString(body.isActive) !== 'false'
  };
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function buildInitialClientServiceNames(body = {}) {
  const serviceNames = normalizeStringList(body.services);
  const seen = new Set();
  return serviceNames.filter((name) => {
    const key = normalizeText(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadWorkerFormOptions() {
  const [cities, vacancies] = await Promise.all([
    loadUnifiedCityOptions(prisma),
    prisma.vacancy.findMany({
      where: { isActive: true },
      select: { id: true, title: true, city: true },
      orderBy: [{ city: 'asc' }, { title: 'asc' }]
    })
  ]);

  return { cities, vacancies };
}

async function validateVacanciesForSelectedCities(cityIds, vacancyIds) {
  if (!vacancyIds.length) return [];
  if (!cityIds.length) throw new Error('Selecciona al menos una ciudad operativa antes de elegir perfiles.');

  const selectedCityIdGroups = await Promise.all(cityIds.map((cityId) => resolveEquivalentCityIds(prisma, cityId)));
  const equivalentCityIds = selectedCityIdGroups.flat();
  const selectedCities = await prisma.city.findMany({
    where: { id: { in: equivalentCityIds } },
    select: { name: true }
  });
  const selectedCityNames = new Set(selectedCities.map((city) => normalizeText(city.name)));

  const validVacancies = await prisma.vacancy.findMany({
    where: { id: { in: vacancyIds }, isActive: true },
    select: { id: true, city: true }
  });

  const validVacancyIds = validVacancies
    .filter((vacancy) => selectedCityNames.has(normalizeText(vacancy.city)))
    .map((vacancy) => vacancy.id);

  if (validVacancyIds.length !== vacancyIds.length) {
    throw new Error('Uno o más perfiles no pertenecen a las ciudades seleccionadas o no están activos.');
  }

  return validVacancyIds;
}

async function replaceWorkerRelations(workerId, body) {
  const cityIds = normalizeStringList(body.cityIds);
  const vacancyIds = normalizeStringList(body.vacancyIds);
  const validVacancyIds = await validateVacanciesForSelectedCities(cityIds, vacancyIds);

  await prisma.$transaction([
    prisma.dispatchWorkerCity.deleteMany({ where: { workerId } }),
    prisma.dispatchWorkerVacancy.deleteMany({ where: { workerId } }),
    ...(cityIds.length ? [prisma.dispatchWorkerCity.createMany({ data: cityIds.map((cityId) => ({ workerId, cityId })), skipDuplicates: true })] : []),
    ...(validVacancyIds.length ? [prisma.dispatchWorkerVacancy.createMany({ data: validVacancyIds.map((vacancyId) => ({ workerId, vacancyId })), skipDuplicates: true })] : [])
  ]);
}

async function saveWorkerCv(workerId, file) {
  if (!file) return;
  if (!ALLOWED_WORKER_CV_MIME_TYPES.has(file.mimetype)) {
    throw new Error('La hoja de vida debe ser PDF, DOC o DOCX.');
  }

  await prisma.$executeRaw`
    UPDATE "DispatchWorker"
    SET "cvOriginalName" = ${file.originalname},
        "cvMimeType" = ${file.mimetype},
        "cvData" = ${file.buffer}
    WHERE "id" = ${workerId}
  `;
}

async function findWorkerOr404(workerId) {
  return prisma.dispatchWorker.findUnique({
    where: { id: workerId },
    include: { cities: true, vacancies: true, candidate: true }
  });
}

function buildCandidateProfileData(body) {
  const ageValue = normalizeString(body.age);
  const age = ageValue === null ? null : Number(ageValue);
  const allowedGenders = new Set(['UNKNOWN', 'FEMALE', 'MALE', 'OTHER']);
  const gender = normalizeString(body.gender);

  return {
    age: Number.isInteger(age) && age >= 0 ? age : null,
    gender: allowedGenders.has(gender) ? gender : 'UNKNOWN',
    medicalRestrictions: normalizeString(body.medicalRestrictions),
    experienceInfo: normalizeString(body.experienceInfo),
    experienceTime: normalizeString(body.experienceTime),
    experienceSummary: normalizeString(body.experienceSummary)
  };
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

  router.get('/api/ciudades', requireOps, async (_req, res) => {
    const allCities = await loadUnifiedCityOptions(prisma);
    const cities = allCities.filter((city) => city.usedForDispatch);
    return res.json({ cities, generatedAt: new Date().toISOString() });
  });

  router.post('/admin-clientes', requireOps, async (req, res) => {
    const data = buildClientData(req.body);
    if (!data.name) return res.status(400).send('Nombre requerido');
    const serviceNames = buildInitialClientServiceNames(req.body);
    const createdByUsername = req.session?.username || req.username || null;
    await prisma.dispatchClient.create({
      data: {
        ...data,
        publicToken: randomBytes(24).toString('hex'),
        createdByUsername,
        ...(serviceNames.length ? {
          services: {
            create: serviceNames.map((name) => ({ name, createdByUsername }))
          }
        } : {})
      }
    });
    return res.redirect(redirectWithMessage('/admin/operaciones/clientes', 'Cliente creado.'));
  });

  router.post('/admin-clientes/:clientId/editar', requireOps, async (req, res) => {
    const data = buildClientData(req.body);
    if (!data.name) return res.status(400).send('Nombre requerido');
    await prisma.dispatchClient.update({ where: { id: req.params.clientId }, data });
    return res.redirect(redirectWithMessage('/admin/operaciones/clientes', 'Cliente actualizado.'));
  });

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

  router.post('/admin-delete/solicitudes/:serviceRequestId', requireOps, async (req, res) => {
    const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.serviceRequestId }, select: { id: true } });
    if (!serviceRequest) return res.status(404).send('Solicitud no encontrada');

    return runDelete(
      res,
      '/admin/operaciones/asignaciones',
      `/admin/operaciones/asignaciones?serviceRequestId=${serviceRequest.id}`,
      () => prisma.dispatchServiceRequest.delete({ where: { id: serviceRequest.id } }),
      'Solicitud eliminada correctamente.',
      'No fue posible eliminar la solicitud porque tiene asignaciones o dependencias operativas.'
    );
  });

  router.post('/admin-delete/personal/:workerId', requireOps, async (req, res) => {
    const worker = await prisma.dispatchWorker.findUnique({ where: { id: req.params.workerId }, select: { id: true } });
    if (!worker) return res.status(404).send('Auxiliar no encontrado');

    return runDelete(
      res,
      '/admin/operaciones/personal',
      '/admin/operaciones/personal',
      () => prisma.dispatchWorker.delete({ where: { id: worker.id } }),
      'Auxiliar eliminado correctamente.',
      'No fue posible eliminar el auxiliar porque tiene dependencias operativas.'
    );
  });

  router.get('/admin-worker/nuevo', requireOps, async (req, res) => {
    const { cities, vacancies } = await loadWorkerFormOptions();
    return res.render('operacionesPersonalNuevo', {
      cities,
      vacancies,
      worker: null,
      mode: 'create',
      formAction: '/operaciones/admin-worker/nuevo',
      role: req.session?.userRole || req.userRole,
      error: normalizeString(req.query.error)
    });
  });

  router.post('/admin-worker/nuevo', requireOps, workerCvUpload.single('cvFile'), async (req, res) => {
    try {
      const workerData = buildWorkerData(req.body);
      if (!workerData.fullName) return res.redirect('/operaciones/admin-worker/nuevo?error=' + encodeURIComponent('Nombre requerido.'));
      const worker = await prisma.dispatchWorker.create({ data: { ...workerData, source: 'MANUAL' } });
      await replaceWorkerRelations(worker.id, req.body);
      await saveWorkerCv(worker.id, req.file);
      return res.redirect('/admin/operaciones/personal?message=' + encodeURIComponent('Auxiliar manual creado.'));
    } catch (error) {
      console.error(error);
      return res.redirect('/operaciones/admin-worker/nuevo?error=' + encodeURIComponent(error.message || 'No fue posible crear el auxiliar.'));
    }
  });

  router.get('/admin-worker/:workerId/editar', requireOps, async (req, res) => {
    const [worker, options] = await Promise.all([findWorkerOr404(req.params.workerId), loadWorkerFormOptions()]);
    if (!worker) return res.status(404).send('Auxiliar no encontrado');
    return res.render('operacionesPersonalNuevo', {
      cities: options.cities,
      vacancies: options.vacancies,
      worker,
      mode: 'edit',
      formAction: `/operaciones/admin-worker/${worker.id}/editar`,
      role: req.session?.userRole || req.userRole,
      error: normalizeString(req.query.error)
    });
  });

  router.post('/admin-worker/:workerId/editar', requireOps, workerCvUpload.single('cvFile'), async (req, res) => {
    try {
      const existing = await findWorkerOr404(req.params.workerId);
      if (!existing) return res.status(404).send('Auxiliar no encontrado');
      const workerData = buildWorkerData(req.body);
      if (!workerData.fullName) return res.redirect(`/operaciones/admin-worker/${existing.id}/editar?error=` + encodeURIComponent('Nombre requerido.'));
      await prisma.$transaction([
        prisma.dispatchWorker.update({ where: { id: existing.id }, data: workerData }),
        ...(existing.candidateId ? [prisma.candidate.update({
          where: { id: existing.candidateId },
          data: {
            fullName: workerData.fullName,
            phone: workerData.phone || existing.candidate.phone,
            documentType: workerData.documentType,
            documentNumber: workerData.documentNumber,
            locality: workerData.residenceLocality,
            transportMode: workerData.transportMode,
            ...buildCandidateProfileData(req.body)
          }
        })] : [])
      ]);
      await replaceWorkerRelations(existing.id, req.body);
      await saveWorkerCv(existing.id, req.file);
      return res.redirect('/admin/operaciones/personal?message=' + encodeURIComponent('Auxiliar actualizado.'));
    } catch (error) {
      console.error(error);
      return res.redirect(`/operaciones/admin-worker/${req.params.workerId}/editar?error=` + encodeURIComponent(error.message || 'No fue posible actualizar el auxiliar.'));
    }
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

    let startTime = null;
    let endTime = null;
    try {
      startTime = normalizeOptionalTime(req.body.startTime);
      endTime = normalizeOptionalTime(req.body.endTime);
    } catch (error) {
      return res.status(400).send(error.message || 'Horario invalido. Usa formato HH:mm.');
    }

    await prisma.dispatchServiceRequest.create({
      data: {
        operationPointId: operationPoint.id,
        clientName: client.name,
        operationPointName: operationPoint.name,
        cityName: operationPoint.cityName || client.cityName,
        address: operationPoint.address,
        serviceId: selectedService?.id || null,
        serviceName: selectedService?.name || null,
        serviceDate: new Date(serviceDate),
        startTime,
        endTime,
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
