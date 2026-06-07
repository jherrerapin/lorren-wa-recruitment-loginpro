import express from 'express';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { upsertDispatchWorkerFromCandidate } from '../services/dispatchWorkerSync.js';
import { loadUnifiedCityOptions, resolveEquivalentCityIds } from '../services/cityOptions.js';
import { normalizeTransportMode, uniqueNormalizedTransportModes } from '../services/transportMode.js';

const TIME_HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeString(item)).filter(Boolean);
  const single = normalizeString(value);
  return single ? [single] : [];
}
function normalizeOptionalTime(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (!TIME_HH_MM_PATTERN.test(normalized)) throw new Error('Horario invalido. Usa formato HH:mm.');
  return normalized;
}
function resolveRequestTimes(body) {
  return {
    startTime: normalizeOptionalTime(body.startTime),
    endTime: normalizeOptionalTime(body.endTime)
  };
}
async function resolveCompatibleOperationalCityIds(operationalCityId) {
  return resolveEquivalentCityIds(prisma, operationalCityId);
}
function buildOperationalCityFilter(compatibleOperationalCityIds) { if (!compatibleOperationalCityIds.length) return {}; return { cities: { some: { cityId: { in: compatibleOperationalCityIds } } } }; }
function buildDispatchEligibilityFilter(status = null) {
  return status ? { operationalStatus: status } : { operationalStatus: 'ACTIVE' };
}
function isOpsUser(req) { const username = normalizeString(req.session?.username || req.username); return Boolean(username?.startsWith('operaciones-despacho')); }
function canUseOps(req) { const role = req.session?.userRole || req.userRole; const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch); return role === 'dev' || canAccessDispatch || isOpsUser(req); }
function requireOps(req, res, next) { const role = req.session?.userRole || req.userRole; if (!role) return res.redirect('/login'); if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario'); return next(); }
function requireDev(req, res, next) { const role = req.session?.userRole || req.userRole; if (role !== 'dev') return res.status(403).send('Solo DEV'); return next(); }
async function recalculateServiceRequestStatus(serviceRequestId) {
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true, requiredWorkers: true } });
  if (!serviceRequest) return;
  const assignedCount = await prisma.dispatchAssignment.count({ where: { serviceRequestId } });
  let status = 'PENDING_ASSIGNMENT';
  if (assignedCount >= serviceRequest.requiredWorkers) status = 'ASSIGNMENT_COMPLETE'; else if (assignedCount > 0) status = 'ASSIGNMENT_PARTIAL';
  await prisma.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
}
function renderOperationsDashboard(res, options = {}) { return res.render('operacionesDashboard', { pageTitle: 'Operaciones / Despacho', subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.', activeSection: 'dashboard', ...options }); }
async function resolveDispatchService(serviceId) {
  const normalizedServiceId = normalizeString(serviceId);
  if (!normalizedServiceId) return null;
  return prisma.dispatchClientService.findFirst({ where: { id: normalizedServiceId, isActive: true }, include: { client: true } });
}
function serviceRequestServiceData(service) { return { serviceId: service?.id || null, serviceName: service?.name || null }; }
function redirectClientOperations(clientId, message) { const suffix = message ? `?message=${encodeURIComponent(message)}` : ''; return `/admin/operaciones/clientes/${clientId}/operaciones${suffix}`; }
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
async function replaceWorkerRelations(workerId, body) {
  const cityIds = normalizeStringList(body.cityIds);
  const vacancyIds = normalizeStringList(body.vacancyIds);
  await prisma.$transaction([
    prisma.dispatchWorkerCity.deleteMany({ where: { workerId } }),
    prisma.dispatchWorkerVacancy.deleteMany({ where: { workerId } }),
    ...(cityIds.length ? [prisma.dispatchWorkerCity.createMany({ data: cityIds.map((cityId) => ({ workerId, cityId })), skipDuplicates: true })] : []),
    ...(vacancyIds.length ? [prisma.dispatchWorkerVacancy.createMany({ data: vacancyIds.map((vacancyId) => ({ workerId, vacancyId })), skipDuplicates: true })] : [])
  ]);
}
async function findManualWorkerOr404(workerId) { return prisma.dispatchWorker.findFirst({ where: { id: workerId, source: 'MANUAL' }, include: { cities: true, vacancies: true } }); }
async function loadDispatchCities() { return loadUnifiedCityOptions(prisma); }
async function loadRequestFormClients() {
  return prisma.dispatchClient.findMany({ where: { isActive: true }, include: { operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } }, services: { where: { isActive: true }, orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } });
}
async function resolveRequestSelection(body) {
  const clientId = normalizeString(body.clientId);
  const operationPointId = normalizeString(body.operationPointId);
  const serviceId = normalizeString(body.serviceId);
  if (!clientId || !operationPointId) return { error: 'Selecciona cliente y operación válidos.' };
  const client = await prisma.dispatchClient.findFirst({ where: { id: clientId, isActive: true }, include: { operationPoints: { where: { isActive: true } }, services: { where: { isActive: true } } } });
  if (!client) return { error: 'Cliente no encontrado o inactivo.' };
  const operationPoint = client.operationPoints.find((item) => item.id === operationPointId);
  if (!operationPoint) return { error: 'La operación seleccionada no pertenece al cliente o está inactiva.' };
  const selectedService = serviceId ? client.services.find((item) => item.id === serviceId) || null : null;
  if (client.services.length && !selectedService) return { error: 'Selecciona un servicio válido del cliente.' };
  return { client, operationPoint, selectedService };
}

export function dispatchBridgeRouter() {
  const router = express.Router();
  router.get('/', requireOps, (_req, res) => renderOperationsDashboard(res));
  router.get('/abrir', requireOps, (_req, res) => renderOperationsDashboard(res));
  router.get('/solicitudes', requireOps, async (req, res) => {
    const serviceRequests = await prisma.dispatchServiceRequest.findMany({ include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] });
    return res.render('operacionesSolicitudes', { serviceRequests, role: req.session?.userRole || req.userRole });
  });

  router.get('/clientes', requireOps, async (req, res) => {
    const clients = await prisma.dispatchClient.findMany({ include: { _count: { select: { operationPoints: true, services: true } } }, orderBy: { createdAt: 'desc' } });
    const cities = await loadDispatchCities();
    return res.render('operacionesClientes', { clients, cities, role: req.session?.userRole || req.userRole, message: normalizeString(req.query.message), baseUrl: `${req.protocol}://${req.get('host')}` });
  });
  router.post('/clientes', requireOps, async (req, res) => {
    const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre requerido');
    await prisma.dispatchClient.create({ data: { name, publicToken: randomBytes(24).toString('hex'), nit: normalizeString(req.body.nit), contactName: normalizeString(req.body.contactName), contactPhone: normalizeString(req.body.contactPhone), contactEmail: normalizeString(req.body.contactEmail), notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false', createdByUsername: req.session?.username || req.username || null } });
    return res.redirect('/admin/operaciones/clientes');
  });
  router.get('/clientes/:clientId/editar', requireOps, async (req, res) => {
    const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId } });
    if (!client) return res.status(404).send('Cliente no encontrado');
    const [clients, cities] = await Promise.all([
      prisma.dispatchClient.findMany({ include: { _count: { select: { operationPoints: true, services: true } } }, orderBy: { createdAt: 'desc' } }),
      loadDispatchCities()
    ]);
    return res.render('operacionesClientes', { clients, cities, editClient: client, role: req.session?.userRole || req.userRole, message: normalizeString(req.query.message), baseUrl: `${req.protocol}://${req.get('host')}` });
  });
  router.post('/clientes/:clientId/editar', requireOps, async (req, res) => { const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre requerido'); await prisma.dispatchClient.update({ where: { id: req.params.clientId }, data: { name, nit: normalizeString(req.body.nit), contactName: normalizeString(req.body.contactName), contactPhone: normalizeString(req.body.contactPhone), contactEmail: normalizeString(req.body.contactEmail), notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false' } }); return res.redirect(`/admin/operaciones/clientes?message=${encodeURIComponent('Cliente actualizado.')}`); });
  router.post('/clientes/:clientId/toggle', requireOps, async (req, res) => { const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId }, select: { id: true, isActive: true } }); if (!client) return res.status(404).send('Cliente no encontrado'); await prisma.dispatchClient.update({ where: { id: client.id }, data: { isActive: !client.isActive } }); return res.redirect(`/admin/operaciones/clientes?message=${encodeURIComponent(client.isActive ? 'Cliente desactivado.' : 'Cliente reactivado.')}`); });
  router.post('/clientes/:clientId/regenerar-link', requireOps, async (req, res) => { const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId }, select: { id: true } }); if (!client) return res.status(404).send('Cliente no encontrado'); await prisma.dispatchClient.update({ where: { id: client.id }, data: { publicToken: randomBytes(24).toString('hex') } }); return res.redirect(`/admin/operaciones/clientes?message=${encodeURIComponent('Link público regenerado.')}`); });
  router.post('/clientes/:clientId/eliminar', requireOps, async (req, res) => { await prisma.dispatchClient.update({ where: { id: req.params.clientId }, data: { isActive: false } }); return res.redirect(`/admin/operaciones/clientes?message=${encodeURIComponent('Cliente eliminado del flujo activo.')}`); });
  router.get('/clientes/:clientId/operaciones', requireOps, async (req, res) => { const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId }, include: { operationPoints: { orderBy: { createdAt: 'desc' } }, services: { orderBy: { createdAt: 'desc' } } } }); if (!client) return res.status(404).send('Cliente no encontrado'); return res.render('operacionesClienteOperaciones', { client, role: req.session?.userRole || req.userRole, message: normalizeString(req.query.message), baseUrl: `${req.protocol}://${req.get('host')}` }); });
  router.post('/clientes/:clientId/operaciones', requireOps, async (req, res) => { const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId }, select: { id: true } }); if (!client) return res.status(404).send('Cliente no encontrado'); const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre requerido'); await prisma.dispatchOperationPoint.create({ data: { clientId: client.id, name, cityName: normalizeString(req.body.cityName), address: normalizeString(req.body.address), contactName: normalizeString(req.body.contactName), contactPhone: normalizeString(req.body.contactPhone), notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false', publicToken: randomBytes(24).toString('hex'), createdByUsername: req.session?.username || req.username || null } }); return res.redirect(redirectClientOperations(client.id, 'Operación creada.')); });
  router.post('/clientes/:clientId/operaciones/:operationId/editar', requireOps, async (req, res) => { const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre requerido'); const operation = await prisma.dispatchOperationPoint.findFirst({ where: { id: req.params.operationId, clientId: req.params.clientId }, select: { id: true } }); if (!operation) return res.status(404).send('Operación no encontrada'); await prisma.dispatchOperationPoint.update({ where: { id: operation.id }, data: { name, cityName: normalizeString(req.body.cityName), address: normalizeString(req.body.address), contactName: normalizeString(req.body.contactName), contactPhone: normalizeString(req.body.contactPhone), notes: normalizeString(req.body.notes), isActive: normalizeString(req.body.isActive) !== 'false' } }); return res.redirect(redirectClientOperations(req.params.clientId, 'Operación actualizada.')); });
  router.post('/clientes/:clientId/operaciones/:operationId/toggle', requireOps, async (req, res) => { const operation = await prisma.dispatchOperationPoint.findFirst({ where: { id: req.params.operationId, clientId: req.params.clientId }, select: { id: true, isActive: true } }); if (!operation) return res.status(404).send('Operación no encontrada'); await prisma.dispatchOperationPoint.update({ where: { id: operation.id }, data: { isActive: !operation.isActive } }); return res.redirect(redirectClientOperations(req.params.clientId, operation.isActive ? 'Operación desactivada.' : 'Operación reactivada.')); });
  router.post('/clientes/:clientId/operaciones/:operationId/eliminar', requireOps, async (req, res) => { const operation = await prisma.dispatchOperationPoint.findFirst({ where: { id: req.params.operationId, clientId: req.params.clientId }, select: { id: true } }); if (!operation) return res.status(404).send('Operación no encontrada'); await prisma.dispatchOperationPoint.update({ where: { id: operation.id }, data: { isActive: false } }); return res.redirect(redirectClientOperations(req.params.clientId, 'Operación eliminada del flujo activo.')); });
  router.post('/clientes/:clientId/servicios', requireOps, async (req, res) => { const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId }, select: { id: true } }); if (!client) return res.status(404).send('Cliente no encontrado'); const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre del servicio requerido'); await prisma.dispatchClientService.create({ data: { clientId: client.id, name, description: normalizeString(req.body.description), isActive: normalizeString(req.body.isActive) !== 'false', createdByUsername: req.session?.username || req.username || null } }); return res.redirect(redirectClientOperations(client.id, 'Servicio creado.')); });
  router.post('/clientes/:clientId/servicios/:serviceId/editar', requireOps, async (req, res) => { const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre del servicio requerido'); const service = await prisma.dispatchClientService.findFirst({ where: { id: req.params.serviceId, clientId: req.params.clientId }, select: { id: true } }); if (!service) return res.status(404).send('Servicio no encontrado'); await prisma.dispatchClientService.update({ where: { id: service.id }, data: { name, description: normalizeString(req.body.description), isActive: normalizeString(req.body.isActive) !== 'false' } }); return res.redirect(redirectClientOperations(req.params.clientId, 'Servicio actualizado.')); });
  router.post('/clientes/:clientId/servicios/:serviceId/toggle', requireOps, async (req, res) => { const service = await prisma.dispatchClientService.findFirst({ where: { id: req.params.serviceId, clientId: req.params.clientId }, select: { id: true, isActive: true } }); if (!service) return res.status(404).send('Servicio no encontrado'); await prisma.dispatchClientService.update({ where: { id: service.id }, data: { isActive: !service.isActive } }); return res.redirect(redirectClientOperations(req.params.clientId, service.isActive ? 'Servicio desactivado.' : 'Servicio reactivado.')); });
  router.post('/clientes/:clientId/servicios/:serviceId/eliminar', requireOps, async (req, res) => { const service = await prisma.dispatchClientService.findFirst({ where: { id: req.params.serviceId, clientId: req.params.clientId }, select: { id: true } }); if (!service) return res.status(404).send('Servicio no encontrado'); await prisma.dispatchClientService.update({ where: { id: service.id }, data: { isActive: false } }); return res.redirect(redirectClientOperations(req.params.clientId, 'Servicio eliminado del flujo activo.')); });

  router.get('/asignaciones', requireOps, async (req, res) => {
    const q = normalizeString(req.query.q); const operationalCityId = normalizeString(req.query.operationalCityId); const vacancyId = normalizeString(req.query.vacancyId); const transportMode = normalizeTransportMode(req.query.transportMode); const locality = normalizeString(req.query.locality); const status = normalizeString(req.query.status);
    const compatibleOperationalCityIds = await resolveCompatibleOperationalCityIds(operationalCityId); const operationalCityFilter = buildOperationalCityFilter(compatibleOperationalCityIds); const dispatchEligibilityFilter = buildDispatchEligibilityFilter(status);
    const workers = await prisma.dispatchWorker.findMany({ where: { ...dispatchEligibilityFilter, ...(q ? { AND: [{ OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] }] } : {}), ...operationalCityFilter, ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}), ...(transportMode ? { transportMode } : {}), ...(locality ? { residenceLocality: locality } : {}) }, include: { candidate: true, cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } });
    const localityWhere = { ...dispatchEligibilityFilter, ...operationalCityFilter, ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}), ...(transportMode ? { transportMode } : {}) };
    const transportWhere = { ...dispatchEligibilityFilter, ...operationalCityFilter, ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}), ...(locality ? { residenceLocality: locality } : {}) };
    const serviceRequestId = normalizeString(req.query.serviceRequestId);
    const [cities, vacancies, transportModeRows, localityRows, serviceRequests, clients] = await Promise.all([
      loadDispatchCities(), prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } }), prisma.dispatchWorker.findMany({ where: transportWhere, select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }), prisma.dispatchWorker.findMany({ where: localityWhere, select: { residenceLocality: true }, distinct: ['residenceLocality'], orderBy: { residenceLocality: 'asc' } }), prisma.dispatchServiceRequest.findMany({ include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] }), loadRequestFormClients()
    ]);
    const selectedServiceRequest = serviceRequestId ? serviceRequests.find((item) => item.id === serviceRequestId) || null : serviceRequests[0] || null;
    return res.render('operacionesAsignaciones', { workers, cities, vacancies, serviceRequests, selectedServiceRequest, selectedServiceRequestId: selectedServiceRequest?.id || '', clients, message: normalizeString(req.query.message), filters: { q: q || '', operationalCityId: operationalCityId || '', vacancyId: vacancyId || '', transportMode: transportMode || '', locality: locality || '', status: status || '' }, transportModes: uniqueNormalizedTransportModes(transportModeRows.map((row) => row.transportMode)), localities: localityRows.map((row) => row.residenceLocality).filter(Boolean), role: req.session?.userRole || req.userRole, canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) });
  });

  router.get('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => { const [serviceRequest, clients] = await Promise.all([prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.id }, include: { service: true } }), loadRequestFormClients()]); if (!serviceRequest) return res.status(404).send('Solicitud no encontrada'); return res.render('operacionesSolicitudEditar', { serviceRequest, clients, role: req.session?.userRole || req.userRole }); });
  router.post('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => { const requiredWorkersRaw = Number(req.body.requiredWorkers); if (!Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) return res.status(400).send('Cantidad de auxiliares inválida.'); const selection = await resolveRequestSelection(req.body); if (selection.error) return res.status(400).send(selection.error); let requestTimes; try { requestTimes = resolveRequestTimes(req.body); } catch (error) { return res.status(400).send(error.message || 'Horario invalido. Usa formato HH:mm.'); } await prisma.dispatchServiceRequest.update({ where: { id: req.params.id }, data: { operationPointId: selection.operationPoint.id, clientName: selection.client.name, operationPointName: selection.operationPoint.name, cityName: selection.operationPoint.cityName || selection.client.cityName, address: selection.operationPoint.address, ...serviceRequestServiceData(selection.selectedService), serviceDate: new Date(req.body.serviceDate), ...requestTimes, requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)), notes: normalizeString(req.body.notes), status: normalizeString(req.body.status) || 'PENDING_ASSIGNMENT' } }); await recalculateServiceRequestStatus(req.params.id); return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${req.params.id}`); });
  router.post('/asignaciones/solicitudes', requireOps, async (req, res) => { const selection = await resolveRequestSelection(req.body); const serviceDateRaw = normalizeString(req.body.serviceDate); const requiredWorkersRaw = Number(req.body.requiredWorkers); if (selection.error || !serviceDateRaw || !Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) return res.status(400).send(selection.error || 'Datos inválidos para crear solicitud operativa'); let requestTimes; try { requestTimes = resolveRequestTimes(req.body); } catch (error) { return res.status(400).send(error.message || 'Horario invalido. Usa formato HH:mm.'); } const created = await prisma.dispatchServiceRequest.create({ data: { operationPointId: selection.operationPoint.id, clientName: selection.client.name, operationPointName: selection.operationPoint.name, cityName: selection.operationPoint.cityName || selection.client.cityName, address: selection.operationPoint.address, ...serviceRequestServiceData(selection.selectedService), serviceDate: new Date(serviceDateRaw), ...requestTimes, requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)), notes: normalizeString(req.body.notes), status: 'PENDING_ASSIGNMENT', source: 'INTERNAL', createdByUsername: req.session?.username || req.username || null } }); return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${created.id}`); });
  router.post('/asignaciones/assign', requireOps, async (req, res) => { const serviceRequestId = normalizeString(req.body.serviceRequestId); const workerId = normalizeString(req.body.workerId); if (!serviceRequestId || !workerId) return res.status(400).send('serviceRequestId y workerId son requeridos'); const [serviceRequest, worker] = await Promise.all([prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true, requiredWorkers: true } }), prisma.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true } })]); if (!serviceRequest || !worker) return res.status(404).send('Solicitud o auxiliar no encontrado'); const assignedCount = await prisma.dispatchAssignment.count({ where: { serviceRequestId } }); if (assignedCount >= serviceRequest.requiredWorkers) { await recalculateServiceRequestStatus(serviceRequestId); return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}&message=${encodeURIComponent('La solicitud ya tiene el numero de auxiliares requerido.')}`); } const exists = await prisma.dispatchAssignment.findUnique({ where: { serviceRequestId_workerId: { serviceRequestId, workerId } } }); if (exists) return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}&message=${encodeURIComponent('El auxiliar ya estaba asignado.')}`); await prisma.dispatchAssignment.create({ data: { serviceRequestId, workerId, status: 'ASSIGNED', createdByUsername: req.session?.username || req.username || null } }); await recalculateServiceRequestStatus(serviceRequestId); return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}`); });
  router.post('/asignaciones/unassign', requireOps, async (req, res) => { const assignmentId = normalizeString(req.body.assignmentId); const serviceRequestId = normalizeString(req.body.serviceRequestId); if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos'); await prisma.dispatchAssignment.delete({ where: { id: assignmentId } }); await recalculateServiceRequestStatus(serviceRequestId); return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}`); });

  router.get('/personal', requireOps, async (req, res) => {
    const operationalCityId = normalizeString(req.query.operationalCityId);
    const vacancyId = normalizeString(req.query.vacancyId);
    const status = normalizeString(req.query.status);
    const workers = await prisma.dispatchWorker.findMany({
      where: {
        ...buildDispatchEligibilityFilter(status),
        ...(operationalCityId ? { cities: { some: { cityId: operationalCityId } } } : {}),
        ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {})
      },
      include: { candidate: true, cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } },
      orderBy: { createdAt: 'desc' }
    });
    const cities = await loadDispatchCities();
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
      role: req.session?.userRole || req.userRole,
      canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
    });
  });
  router.get('/personal/nuevo', requireOps, async (req, res) => { const [cities, vacancies] = await Promise.all([loadDispatchCities(), prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } })]); return res.render('operacionesPersonalNuevo', { cities, vacancies, worker: null, mode: 'create', formAction: '/admin/operaciones/personal/nuevo', role: req.session?.userRole || req.userRole }); });
  router.post('/personal/nuevo', requireOps, async (req, res) => { const workerData = buildWorkerData(req.body); if (!workerData.fullName) return res.status(400).send('Nombre requerido'); const worker = await prisma.dispatchWorker.create({ data: { ...workerData, source: 'MANUAL' } }); await replaceWorkerRelations(worker.id, req.body); return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar manual creado.')}`); });
  router.get('/personal/:workerId/editar', requireOps, async (req, res) => { const [worker, cities, vacancies] = await Promise.all([findManualWorkerOr404(req.params.workerId), loadDispatchCities(), prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } })]); if (!worker) return res.status(404).send('Auxiliar manual no encontrado'); return res.render('operacionesPersonalNuevo', { cities, vacancies, worker, mode: 'edit', formAction: `/admin/operaciones/personal/${worker.id}/editar`, role: req.session?.userRole || req.userRole }); });
  router.post('/personal/:workerId/editar', requireOps, async (req, res) => { const existing = await findManualWorkerOr404(req.params.workerId); if (!existing) return res.status(404).send('Auxiliar manual no encontrado'); const workerData = buildWorkerData(req.body); if (!workerData.fullName) return res.status(400).send('Nombre requerido'); await prisma.dispatchWorker.update({ where: { id: existing.id }, data: workerData }); await replaceWorkerRelations(existing.id, req.body); return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar manual actualizado.')}`); });
  router.post('/personal/:workerId/toggle', requireOps, async (req, res) => { const worker = await findManualWorkerOr404(req.params.workerId); if (!worker) return res.status(404).send('Auxiliar manual no encontrado'); const nextStatus = worker.operationalStatus === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'; await prisma.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: nextStatus } }); return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent(nextStatus === 'ACTIVE' ? 'Auxiliar manual reactivado.' : 'Auxiliar manual desactivado.')}`); });
  router.post('/personal/:workerId/eliminar', requireOps, async (req, res) => { const worker = await findManualWorkerOr404(req.params.workerId); if (!worker) return res.status(404).send('Auxiliar manual no encontrado'); await prisma.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: 'INACTIVE' } }); return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar manual eliminado del flujo activo.')}`); });

  router.post('/sync-contratados', requireOps, requireDev, async (_req, res) => { const registered = await prisma.candidate.findMany({ where: { status: 'REGISTRADO' }, select: { id: true } }); for (const candidate of registered) await upsertDispatchWorkerFromCandidate(prisma, candidate.id); return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent(`Modo prueba: sincronización completada con ${registered.length} candidatos registrados procesados.`)}`); });
  router.get('/novedades', requireOps, (_req, res) => renderOperationsDashboard(res, { pageTitle: 'Novedades operativas', activeSection: 'novedades' }));
  router.get('/solicitud/:publicToken', async (req, res) => { const operationPoint = await prisma.dispatchOperationPoint.findFirst({ where: { publicToken: req.params.publicToken, isActive: true }, include: { client: true } }); if (!operationPoint?.client?.isActive) return res.status(404).send('Link no disponible'); return res.redirect(`/operaciones/cliente/${operationPoint.client.publicToken}`); });
  router.post('/solicitud/:publicToken', async (req, res) => { const operationPoint = await prisma.dispatchOperationPoint.findFirst({ where: { publicToken: req.params.publicToken, isActive: true }, include: { client: { include: { operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } }, services: { where: { isActive: true }, orderBy: { name: 'asc' } } } } } }); if (!operationPoint?.client?.isActive) return res.status(404).send('Link no disponible'); const requiredWorkersRaw = Number(req.body.requiredWorkers); const selectedService = operationPoint.client.services.find((service) => service.id === normalizeString(req.body.serviceId)) || null; let requestTimes; try { requestTimes = resolveRequestTimes(req.body); } catch (error) { return res.status(400).send(error.message || 'Horario invalido. Usa formato HH:mm.'); } await prisma.dispatchServiceRequest.create({ data: { operationPointId: operationPoint.id, clientName: operationPoint.client.name, operationPointName: operationPoint.name, cityName: operationPoint.cityName, address: operationPoint.address, ...serviceRequestServiceData(selectedService), serviceDate: new Date(req.body.serviceDate), ...requestTimes, requiredWorkers: Number.isFinite(requiredWorkersRaw) ? Math.max(1, Math.trunc(requiredWorkersRaw)) : 1, notes: normalizeString(req.body.notes), requestedByName: normalizeString(req.body.requestedByName), requestedByPhone: normalizeString(req.body.requestedByPhone), requestedByEmail: normalizeString(req.body.requestedByEmail), source: 'PUBLIC_LINK', status: 'PENDING_ASSIGNMENT' } }); return res.render('publicDispatchRequest', { client: operationPoint.client, operationPoints: operationPoint.client.operationPoints, services: operationPoint.client.services, operationPoint, service: selectedService, success: true }); });

  return router;
}
