import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { sendDispatchCompletionEmail } from '../services/dispatchCompletionEmail.js';
import { loadUnifiedCityOptions } from '../services/cityOptions.js';
import { normalizeTransportMode } from '../services/transportMode.js';

const TEMPLATE_KEY = 'DISPATCH_ASSIGNMENT_WHATSAPP';
const DEFAULT_ASSIGNMENT_TEMPLATE = 'Hola {{nombre}}, te confirmamos asignacion para {{fecha}} en {{operacion}}. Direccion: {{direccion}}. Horario: {{horaInicio}} - {{horaFin}}. Servicio: {{servicio}}. Cliente: {{cliente}}. Por favor confirma recibido.';
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';

const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function normalizeString(value) { if (typeof value !== 'string') return null; const trimmed = value.trim(); return trimmed.length ? trimmed : null; }
function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeString(item)).filter(Boolean);
  const single = normalizeString(value);
  return single ? [single] : [];
}
function normalizeText(value) { return normalizeString(value)?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() || ''; }
function isBogotaSiberiaName(cityName) { const normalized = normalizeText(cityName); return normalized === 'bogota' || normalized === 'bogota d.c.' || normalized === 'bogota dc' || normalized === 'siberia'; }
function setNoStore(res) { res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); }
function isOpsUser(req) { const username = normalizeString(req.session?.username || req.username); return Boolean(username?.startsWith('operaciones-despacho')); }
function canUseOps(req) { const role = req.session?.userRole || req.userRole; const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch); return role === 'dev' || canAccessDispatch || isOpsUser(req); }
function requireOps(req, res, next) { setNoStore(res); const role = req.session?.userRole || req.userRole; if (!role) return res.redirect('/login'); if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario'); return next(); }
function requireDev(req, res, next) { const role = req.session?.userRole || req.userRole; if (role !== 'dev') return res.status(403).send('Solo DEV'); return next(); }
function redirectToAssignment(serviceRequestId, message) { const params = new URLSearchParams(); if (serviceRequestId) params.set('serviceRequestId', serviceRequestId); if (message) params.set('message', message); return `/admin/operaciones/asignaciones?${params.toString()}`; }
function todayIsoDate() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })).toISOString().slice(0, 10); }
function normalizeDateParam(value) { const rawValue = normalizeString(value); if (!rawValue) return todayIsoDate(); if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) return todayIsoDate(); return rawValue; }
function buildUtcDayRangeFromDateValue(value) { const start = new Date(value); start.setUTCHours(0, 0, 0, 0); const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1); return { start, end }; }
function serviceRequestServiceData(service) { return { serviceId: service?.id || null, serviceName: service?.name || null }; }
function buildOperationalCityFilter(compatibleOperationalCityIds) { if (!compatibleOperationalCityIds.length) return {}; return { cities: { some: { cityId: { in: compatibleOperationalCityIds } } } }; }
function cleanDistinctStrings(rows, fieldName) { return [...new Set(rows.map((row) => normalizeString(row[fieldName])).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')); }
function buildDispatchEligibilityFilter() { return { operationalStatus: 'CONTRATADO' }; }
function buildWorkerData(body) {
  return {
    fullName: normalizeString(body.fullName),
    phone: normalizeString(body.phone),
    documentType: normalizeString(body.documentType),
    documentNumber: normalizeString(body.documentNumber),
    residenceCity: normalizeString(body.residenceCity),
    residenceLocality: normalizeString(body.residenceLocality),
    transportMode: normalizeTransportMode(body.transportMode),
    operationalStatus: normalizeString(body.operationalStatus) || 'ACTIVE',
    notes: normalizeString(body.notes)
  };
}
async function resolveDispatchService(prisma, serviceId) { const normalizedServiceId = normalizeString(serviceId); if (!normalizedServiceId) return null; return prisma.dispatchClientService.findFirst({ where: { id: normalizedServiceId, isActive: true }, include: { client: true } }); }
async function getTemplate(prisma) { const template = await prisma.dispatchMessageTemplate.findUnique({ where: { key: TEMPLATE_KEY } }); return template?.content || DEFAULT_ASSIGNMENT_TEMPLATE; }
async function loadDispatchCities(prisma) { return loadUnifiedCityOptions(prisma); }
async function resolveCompatibleOperationalCityIds(prisma, operationalCityId) {
  if (!operationalCityId) return [];
  const selectedCity = await prisma.city.findFirst({ where: { id: operationalCityId, usedForDispatch: true }, select: { id: true, name: true } });
  if (!selectedCity) return [operationalCityId];
  if (!isBogotaSiberiaName(selectedCity.name)) return [selectedCity.id];
  const cities = await loadDispatchCities(prisma);
  const compatibleIds = cities.filter((city) => isBogotaSiberiaName(city.name)).map((city) => city.id);
  return compatibleIds.length ? compatibleIds : [selectedCity.id];
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
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true, requiredWorkers: true } });
  if (!serviceRequest) return null;
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
async function resolveActorEmail(prisma, username) {
  if (!username) return null;
  const user = await prisma.appUser.findUnique({ where: { username }, select: { email: true } });
  return normalizeString(user?.email);
}
async function notifyIfServiceRequestCompleted(prisma, serviceRequestId, actorUsername) {
  const replyTo = await resolveActorEmail(prisma, actorUsername);
  const result = await sendDispatchCompletionEmail(prisma, serviceRequestId, {
    replyTo,
    managedByUsername: actorUsername || null
  });
  if (result?.sent) return ' Solicitud completa: correo enviado al solicitante.';
  if (result?.reason === 'missing_requested_by_email') return ' Solicitud completa: no se envió correo porque no tiene correo del solicitante.';
  if (result?.reason === 'missing_email_config') return ' Solicitud completa: falta configurar correo de salida.';
  if (result?.error) return ' Solicitud completa: no fue posible enviar el correo al solicitante.';
  return '';
}
// Busca cualquier worker (no solo MANUAL) por id
async function findWorkerOr404(prisma, workerId) { return prisma.dispatchWorker.findFirst({ where: { id: workerId }, include: { cities: true, vacancies: true } }); }
// Busca solo workers MANUAL por id (para editar)
async function findManualWorkerOr404(prisma, workerId) { return prisma.dispatchWorker.findFirst({ where: { id: workerId, source: 'MANUAL' }, include: { cities: true, vacancies: true } }); }
async function replaceWorkerRelations(prisma, workerId, body) {
  const cityIds = normalizeStringList(body.cityIds);
  const vacancyIds = normalizeStringList(body.vacancyIds);
  await prisma.$transaction([
    prisma.dispatchWorkerCity.deleteMany({ where: { workerId } }),
    prisma.dispatchWorkerVacancy.deleteMany({ where: { workerId } }),
    ...(cityIds.length ? [prisma.dispatchWorkerCity.createMany({ data: cityIds.map((cityId) => ({ workerId, cityId })), skipDuplicates: true })] : []),
    ...(vacancyIds.length ? [prisma.dispatchWorkerVacancy.createMany({ data: vacancyIds.map((vacancyId) => ({ workerId, vacancyId })), skipDuplicates: true })] : [])
  ]);
}
async function loadDevAuditEventsForRequests(prisma, serviceRequestIds, role) {
  if (role !== 'dev' || !serviceRequestIds.length || !prisma?.devAuditEvent?.findMany) return [];
  try {
    return await prisma.devAuditEvent.findMany({
      where: {
        OR: [
          { entityId: { in: serviceRequestIds } },
          { toValue: { path: ['serviceRequestId'], array_contains: serviceRequestIds } },
          { path: { contains: '/admin/operaciones/asignaciones' } },
          { path: { contains: '/admin/operaciones/solicitudes' } },
          { path: { contains: '/operaciones/cliente/' } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });
  } catch (error) {
    console.warn('No fue posible cargar auditoria dev de solicitudes.', error);
    return [];
  }
}

export function dispatchOpsExtrasRouter(prisma) {
  const router = express.Router();

  router.get('/asignaciones', requireOps, async (req, res) => {
    const q = normalizeString(req.query.q); const operationalCityId = normalizeString(req.query.operationalCityId); const transportMode = normalizeString(req.query.transportMode); const locality = normalizeString(req.query.locality); const serviceRequestId = normalizeString(req.query.serviceRequestId);
    const compatibleOperationalCityIds = await resolveCompatibleOperationalCityIds(prisma, operationalCityId); const operationalCityFilter = buildOperationalCityFilter(compatibleOperationalCityIds);
    const baseWorkerWhere = { operationalStatus: 'CONTRATADO', ...(q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] } : {}), ...operationalCityFilter };
    const workerWhere = { ...baseWorkerWhere, ...(transportMode ? { transportMode } : {}), ...(locality ? { residenceLocality: locality } : {}) };
    const localityWhere = { ...baseWorkerWhere, ...(transportMode ? { transportMode } : {}) };
    const transportModeWhere = { ...baseWorkerWhere, ...(locality ? { residenceLocality: locality } : {}) };
    const [workers, cities, transportModeRows, localityRows, serviceRequests, clients] = await Promise.all([
      prisma.dispatchWorker.findMany({ where: workerWhere, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } }),
      loadDispatchCities(prisma),
      prisma.dispatchWorker.findMany({ where: transportModeWhere, select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }),
      prisma.dispatchWorker.findMany({ where: localityWhere, select: { residenceLocality: true }, distinct: ['residenceLocality'], orderBy: { residenceLocality: 'asc' } }),
      prisma.dispatchServiceRequest.findMany({ include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] }),
      loadActiveClientsForServiceRequestForm(prisma)
    ]);
    const selectedServiceRequest = serviceRequestId ? serviceRequests.find((item) => item.id === serviceRequestId) || null : serviceRequests[0] || null;
    const blockedWorkerIds = new Set(selectedServiceRequest ? selectedServiceRequest.assignments.map((assignment) => assignment.workerId) : []);
    const availableWorkers = workers.filter((worker) => !blockedWorkerIds.has(worker.id));
    const selectedDateRange = selectedServiceRequest ? buildUtcDayRangeFromDateValue(selectedServiceRequest.serviceDate) : null;
    const sameDayAssignments = selectedServiceRequest ? await prisma.dispatchAssignment.findMany({ where: { serviceRequestId: { not: selectedServiceRequest.id }, status: { in: ACTIVE_ASSIGNMENT_STATUSES }, serviceRequest: { serviceDate: { gte: selectedDateRange.start, lt: selectedDateRange.end } } }, select: { workerId: true } }) : [];
    const assignedWorkerIdsOnSelectedDate = new Set(sameDayAssignments.map((assignment) => assignment.workerId));
    return res.render('operacionesAsignacionesConfirmacion', { activeStatuses: ACTIVE_ASSIGNMENT_STATUSES, workers, availableWorkers, assignedWorkerIdsOnSelectedDate, cities, serviceRequests, selectedServiceRequest, selectedServiceRequestId: selectedServiceRequest?.id || '', clients, message: normalizeString(req.query.message), filters: { q: q || '', operationalCityId: operationalCityId || '', transportMode: transportMode || '', locality: locality || '' }, transportModes: cleanDistinctStrings(transportModeRows, 'transportMode'), localities: cleanDistinctStrings(localityRows, 'residenceLocality'), role: req.session?.userRole || req.userRole, canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) });
  });

  router.get('/solicitudes', requireOps, async (req, res) => {
    const role = req.session?.userRole || req.userRole;
    const [serviceRequests, clients] = await Promise.all([
      prisma.dispatchServiceRequest.findMany({ include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] }),
      loadActiveClientsForServiceRequestForm(prisma)
    ]);
    const devAuditEvents = await loadDevAuditEventsForRequests(prisma, serviceRequests.map((item) => item.id), role);
    return res.render('operacionesSolicitudes', { serviceRequests, clients, devAuditEvents, role, message: normalizeString(req.query.message), today: todayIsoDate() });
  });

  router.post('/solicitudes', requireOps, async (req, res) => {
    const clientId = normalizeString(req.body.clientId);
    const operationPointId = normalizeString(req.body.operationPointId);
    const serviceId = normalizeString(req.body.serviceId);
    const serviceDateRaw = normalizeString(req.body.serviceDate);
    const requiredWorkersRaw = Number(req.body.requiredWorkers);
    if (!clientId || !operationPointId || !serviceDateRaw || !Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) return res.status(400).send('Selecciona cliente, punto de operación, fecha y cantidad válida de auxiliares.');
    const client = await prisma.dispatchClient.findFirst({
      where: { id: clientId, isActive: true },
      include: { operationPoints: { where: { isActive: true } }, services: { where: { isActive: true } } }
    });
    if (!client) return res.status(404).send('Cliente no encontrado o inactivo.');
    const operationPoint = client.operationPoints.find((item) => item.id === operationPointId);
    if (!operationPoint) return res.status(400).send('Debes seleccionar una operación válida para el cliente.');
    const selectedService = serviceId ? client.services.find((item) => item.id === serviceId) || null : null;
    if (client.services.length && !selectedService) return res.status(400).send('Debes seleccionar un servicio válido para el cliente.');
    await prisma.dispatchServiceRequest.create({
      data: {
        operationPointId: operationPoint.id,
        clientName: client.name,
        operationPointName: operationPoint.name,
        cityName: operationPoint.cityName || client.cityName,
        address: operationPoint.address || normalizeString(req.body.address),
        ...serviceRequestServiceData(selectedService),
        serviceDate: new Date(serviceDateRaw),
        startTime: normalizeString(req.body.startTime),
        endTime: normalizeString(req.body.endTime),
        requiredWorkers: Math.trunc(requiredWorkersRaw),
        notes: normalizeString(req.body.notes),
        status: 'PENDING_ASSIGNMENT',
        source: 'INTERNAL',
        createdByUsername: req.session?.username || req.username || null
      }
    });
    return res.redirect('/admin/operaciones/solicitudes?message=Solicitud de servicio creada correctamente.');
  });

  router.get('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => {
    const request = await prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.id }, include: { service: true, operationPoint: true } });
    if (!request) return res.status(404).send('Solicitud no encontrada');
    const clients = await loadActiveClientsForServiceRequestForm(prisma);
    return res.render('operacionesSolicitudEditar', { request, clients, role: req.session?.userRole || req.userRole });
  });

  router.post('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => {
    const request = await prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.id }, include: { assignments: true } });
    if (!request) return res.status(404).send('Solicitud no encontrada');
    if (request.assignments.length) return res.status(400).send('No se puede editar una solicitud que ya tiene asignaciones.');
    const clientId = normalizeString(req.body.clientId);
    const operationPointId = normalizeString(req.body.operationPointId);
    const serviceId = normalizeString(req.body.serviceId);
    if (!clientId || !operationPointId) return res.status(400).send('Selecciona cliente y punto de operación.');
    const client = await prisma.dispatchClient.findFirst({ where: { id: clientId, isActive: true }, include: { operationPoints: { where: { isActive: true } }, services: { where: { isActive: true } } } });
    if (!client) return res.status(404).send('Cliente no encontrado.');
    const operationPoint = client.operationPoints.find((item) => item.id === operationPointId);
    if (!operationPoint) return res.status(400).send('Punto de operación inválido.');
    const selectedService = serviceId ? client.services.find((item) => item.id === serviceId) || null : null;
    await prisma.dispatchServiceRequest.update({
      where: { id: request.id },
      data: {
        operationPointId: operationPoint.id,
        clientName: client.name,
        operationPointName: operationPoint.name,
        cityName: operationPoint.cityName || client.cityName,
        address: operationPoint.address || normalizeString(req.body.address),
        ...serviceRequestServiceData(selectedService),
        serviceDate: new Date(normalizeString(req.body.serviceDate)),
        startTime: normalizeString(req.body.startTime),
        endTime: normalizeString(req.body.endTime),
        requiredWorkers: Math.max(1, Math.trunc(Number(req.body.requiredWorkers) || 1)),
        notes: normalizeString(req.body.notes)
      }
    });
    return res.redirect('/admin/operaciones/solicitudes?message=Solicitud actualizada correctamente.');
  });

  router.post('/solicitudes/:id/eliminar', requireOps, async (req, res) => {
    await prisma.dispatchServiceRequest.delete({ where: { id: req.params.id } });
    return res.redirect('/admin/operaciones/solicitudes?message=Solicitud eliminada correctamente.');
  });

  router.get('/clientes', requireOps, async (_req, res) => {
    const clients = await loadActiveClientsForServiceRequestForm(prisma);
    return res.render('operacionesClientes', { clients, message: null });
  });

  router.post('/clientes', requireOps, async (req, res) => {
    const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre de cliente obligatorio.');
    await prisma.dispatchClient.create({ data: { name, nit: normalizeString(req.body.nit), cityName: normalizeString(req.body.cityName), contactName: normalizeString(req.body.contactName), contactPhone: normalizeString(req.body.contactPhone), contactEmail: normalizeString(req.body.contactEmail), notes: normalizeString(req.body.notes), createdByUsername: req.session?.username || req.username || null } });
    return res.redirect('/admin/operaciones/clientes?message=Cliente creado correctamente.');
  });

  router.post('/clientes/:id/desactivar', requireOps, async (req, res) => {
    await prisma.dispatchClient.update({ where: { id: req.params.id }, data: { isActive: false } });
    return res.redirect('/admin/operaciones/clientes?message=Cliente desactivado.');
  });

  router.post('/clientes/:id/operaciones', requireOps, async (req, res) => {
    const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre de operación obligatorio.');
    await prisma.dispatchOperationPoint.create({ data: { clientId: req.params.id, name, cityName: normalizeString(req.body.cityName), address: normalizeString(req.body.address), contactName: normalizeString(req.body.contactName), contactPhone: normalizeString(req.body.contactPhone), notes: normalizeString(req.body.notes), createdByUsername: req.session?.username || req.username || null } });
    return res.redirect('/admin/operaciones/clientes?message=Operación creada correctamente.');
  });

  router.post('/clientes/operaciones/:id/desactivar', requireOps, async (req, res) => {
    await prisma.dispatchOperationPoint.update({ where: { id: req.params.id }, data: { isActive: false } });
    return res.redirect('/admin/operaciones/clientes?message=Operación desactivada.');
  });

  router.post('/clientes/:id/servicios', requireOps, async (req, res) => {
    const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre de servicio obligatorio.');
    await prisma.dispatchClientService.create({ data: { clientId: req.params.id, name, description: normalizeString(req.body.description), createdByUsername: req.session?.username || req.username || null } });
    return res.redirect('/admin/operaciones/clientes?message=Servicio creado correctamente.');
  });

  router.post('/clientes/servicios/:id/desactivar', requireOps, async (req, res) => {
    await prisma.dispatchClientService.update({ where: { id: req.params.id }, data: { isActive: false } });
    return res.redirect('/admin/operaciones/clientes?message=Servicio desactivado.');
  });

  router.get('/personal', requireOps, async (req, res) => {
    const workers = await prisma.dispatchWorker.findMany({ where: { source: 'MANUAL' }, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { fullName: 'asc' } });
