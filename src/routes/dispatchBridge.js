import express from 'express';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { upsertDispatchWorkerFromCandidate } from '../services/dispatchWorkerSync.js';

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
function normalizeText(value) { return normalizeString(value)?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() || ''; }
function isBogotaSiberiaName(cityName) { const normalized = normalizeText(cityName); return normalized === 'bogota' || normalized === 'bogota d.c.' || normalized === 'bogota dc' || normalized === 'siberia'; }
async function resolveCompatibleOperationalCityIds(operationalCityId) {
  if (!operationalCityId) return [];
  const selectedCity = await prisma.city.findUnique({ where: { id: operationalCityId }, select: { id: true, name: true } });
  if (!selectedCity) return [operationalCityId];
  if (!isBogotaSiberiaName(selectedCity.name)) return [selectedCity.id];
  const cities = await prisma.city.findMany({ select: { id: true, name: true } });
  const compatibleIds = cities.filter((city) => isBogotaSiberiaName(city.name)).map((city) => city.id);
  return compatibleIds.length ? compatibleIds : [selectedCity.id];
}
function buildOperationalCityFilter(compatibleOperationalCityIds) { if (!compatibleOperationalCityIds.length) return {}; return { cities: { some: { cityId: { in: compatibleOperationalCityIds } } } }; }
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

export function dispatchBridgeRouter() {
  const router = express.Router();
  router.get('/', requireOps, (_req, res) => renderOperationsDashboard(res));
  router.get('/abrir', requireOps, (_req, res) => renderOperationsDashboard(res));
  router.get('/solicitudes', requireOps, async (req, res) => {
    const serviceRequests = await prisma.dispatchServiceRequest.findMany({
      include: { assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } },
      orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }]
    });
    return res.render('operacionesSolicitudes', { serviceRequests, role: req.session?.userRole || req.userRole });
  });

  router.get('/clientes', requireOps, async (req, res) => {
    const clients = await prisma.dispatchClient.findMany({ include: { _count: { select: { operationPoints: true } } }, orderBy: { createdAt: 'desc' } });
    return res.render('operacionesClientes', { clients, role: req.session?.userRole || req.userRole, message: normalizeString(req.query.message) });
  });
  router.post('/clientes', requireOps, async (req, res) => {
    const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre requerido');
    await prisma.dispatchClient.create({ data: { name, nit: normalizeString(req.body.nit), contactName: normalizeString(req.body.contactName), contactPhone: normalizeString(req.body.contactPhone), contactEmail: normalizeString(req.body.contactEmail), notes: normalizeString(req.body.notes), createdByUsername: req.session?.username || req.username || null } });
    return res.redirect('/admin/operaciones/clientes');
  });
  router.get('/clientes/:clientId/operaciones', requireOps, async (req, res) => {
    const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId }, include: { operationPoints: { orderBy: { createdAt: 'desc' } } } });
    if (!client) return res.status(404).send('Cliente no encontrado');
    return res.render('operacionesClienteOperaciones', { client, role: req.session?.userRole || req.userRole, baseUrl: `${req.protocol}://${req.get('host')}` });
  });
  router.post('/clientes/:clientId/operaciones', requireOps, async (req, res) => {
    const client = await prisma.dispatchClient.findUnique({ where: { id: req.params.clientId }, select: { id: true } });
    if (!client) return res.status(404).send('Cliente no encontrado');
    const name = normalizeString(req.body.name); if (!name) return res.status(400).send('Nombre requerido');
    await prisma.dispatchOperationPoint.create({ data: { clientId: client.id, name, cityName: normalizeString(req.body.cityName), address: normalizeString(req.body.address), contactName: normalizeString(req.body.contactName), contactPhone: normalizeString(req.body.contactPhone), notes: normalizeString(req.body.notes), publicToken: randomBytes(24).toString('hex'), createdByUsername: req.session?.username || req.username || null } });
    return res.redirect(`/admin/operaciones/clientes/${client.id}/operaciones`);
  });

  router.get('/asignaciones', requireOps, async (req, res) => {
    const q = normalizeString(req.query.q); const operationalCityId = normalizeString(req.query.operationalCityId); const vacancyId = normalizeString(req.query.vacancyId); const transportMode = normalizeString(req.query.transportMode); const locality = normalizeString(req.query.locality); const status = normalizeString(req.query.status);
    const compatibleOperationalCityIds = await resolveCompatibleOperationalCityIds(operationalCityId); const operationalCityFilter = buildOperationalCityFilter(compatibleOperationalCityIds);
    const workers = await prisma.dispatchWorker.findMany({ where: { ...(q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] } : {}), ...operationalCityFilter, ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}), ...(transportMode ? { transportMode } : {}), ...(locality ? { residenceLocality: locality } : {}), ...(status ? { operationalStatus: status } : {}) }, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } });
    const localityWhere = { ...operationalCityFilter, ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}), ...(transportMode ? { transportMode } : {}), ...(status ? { operationalStatus: status } : {}) };
    const serviceRequestId = normalizeString(req.query.serviceRequestId);
    const [cities, vacancies, transportModeRows, localityRows, serviceRequests] = await Promise.all([
      prisma.city.findMany({ orderBy: { name: 'asc' } }), prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } }), prisma.dispatchWorker.findMany({ select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }), prisma.dispatchWorker.findMany({ where: localityWhere, select: { residenceLocality: true }, distinct: ['residenceLocality'], orderBy: { residenceLocality: 'asc' } }), prisma.dispatchServiceRequest.findMany({ include: { assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] })
    ]);
    const selectedServiceRequest = serviceRequestId ? serviceRequests.find((item) => item.id === serviceRequestId) || null : serviceRequests[0] || null;
    return res.render('operacionesAsignaciones', { workers, cities, vacancies, serviceRequests, selectedServiceRequest, selectedServiceRequestId: selectedServiceRequest?.id || '', message: normalizeString(req.query.message), filters: { q: q || '', operationalCityId: operationalCityId || '', vacancyId: vacancyId || '', transportMode: transportMode || '', locality: locality || '', status: status || '' }, transportModes: transportModeRows.map((row) => row.transportMode).filter(Boolean), localities: localityRows.map((row) => row.residenceLocality).filter(Boolean), role: req.session?.userRole || req.userRole, canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) });
  });

  router.get('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => {
    const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.id } });
    if (!serviceRequest) return res.status(404).send('Solicitud no encontrada');
    return res.render('operacionesSolicitudEditar', { serviceRequest, role: req.session?.userRole || req.userRole });
  });
  router.post('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res) => {
    const requiredWorkersRaw = Number(req.body.requiredWorkers);
    await prisma.dispatchServiceRequest.update({ where: { id: req.params.id }, data: { clientName: normalizeString(req.body.clientName), operationPointName: normalizeString(req.body.operationPointName), cityName: normalizeString(req.body.cityName), address: normalizeString(req.body.address), serviceDate: new Date(req.body.serviceDate), startTime: normalizeString(req.body.startTime), endTime: normalizeString(req.body.endTime), requiredWorkers: Number.isFinite(requiredWorkersRaw) ? Math.max(1, Math.trunc(requiredWorkersRaw)) : 1, notes: normalizeString(req.body.notes), status: normalizeString(req.body.status) || 'PENDING_ASSIGNMENT' } });
    await recalculateServiceRequestStatus(req.params.id);
    return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${req.params.id}`);
  });

  router.post('/asignaciones/solicitudes', requireOps, async (req, res) => { /* unchanged */
    const clientName = normalizeString(req.body.clientName); const serviceDateRaw = normalizeString(req.body.serviceDate); const requiredWorkersRaw = Number(req.body.requiredWorkers);
    if (!clientName || !serviceDateRaw || !Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) return res.status(400).send('Datos inválidos para crear solicitud operativa');
    const created = await prisma.dispatchServiceRequest.create({ data: { clientName, operationPointName: normalizeString(req.body.operationPointName), cityName: normalizeString(req.body.cityName), address: normalizeString(req.body.address), serviceDate: new Date(serviceDateRaw), startTime: normalizeString(req.body.startTime), endTime: normalizeString(req.body.endTime), requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)), notes: normalizeString(req.body.notes), status: 'PENDING_ASSIGNMENT', source: 'INTERNAL', createdByUsername: req.session?.username || req.username || null } });
    return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${created.id}`);
  });
  router.post('/asignaciones/assign', requireOps, async (req, res) => { const serviceRequestId = normalizeString(req.body.serviceRequestId); const workerId = normalizeString(req.body.workerId); if (!serviceRequestId || !workerId) return res.status(400).send('serviceRequestId y workerId son requeridos'); const [serviceRequest, worker] = await Promise.all([prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true } }), prisma.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true } })]); if (!serviceRequest || !worker) return res.status(404).send('Solicitud o auxiliar no encontrado'); const exists = await prisma.dispatchAssignment.findUnique({ where: { serviceRequestId_workerId: { serviceRequestId, workerId } } }); if (exists) return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}&message=${encodeURIComponent('El auxiliar ya estaba asignado.')}`); await prisma.dispatchAssignment.create({ data: { serviceRequestId, workerId, status: 'ASSIGNED', createdByUsername: req.session?.username || req.username || null } }); await recalculateServiceRequestStatus(serviceRequestId); return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}`); });
  router.post('/asignaciones/unassign', requireOps, async (req, res) => { const assignmentId = normalizeString(req.body.assignmentId); const serviceRequestId = normalizeString(req.body.serviceRequestId); if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos'); await prisma.dispatchAssignment.delete({ where: { id: assignmentId } }); await recalculateServiceRequestStatus(serviceRequestId); return res.redirect(`/admin/operaciones/asignaciones?serviceRequestId=${serviceRequestId}`); });

  router.get('/personal', requireOps, async (req, res) => { const operationalCityId = normalizeString(req.query.operationalCityId); const vacancyId = normalizeString(req.query.vacancyId); const status = normalizeString(req.query.status); const workers = await prisma.dispatchWorker.findMany({ where: { ...(status ? { operationalStatus: status } : {}), ...(operationalCityId ? { cities: { some: { cityId: operationalCityId } } } : {}), ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}) }, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } }); const cities = await prisma.city.findMany({ orderBy: { name: 'asc' } }); const vacancies = await prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } }); return res.render('operacionesPersonal', { pageTitle: 'Personal operativo', subtitle: 'Equipo disponible para asignación.', activeSection: 'personal', workers, cities, vacancies, filters: { operationalCityId: operationalCityId || '', vacancyId: vacancyId || '', status: status || '' }, message: normalizeString(req.query.message), role: req.userRole, canAccessDispatch: req.canAccessDispatch }); });
  router.get('/personal/nuevo', requireOps, async (req, res) => {
    const [cities, vacancies] = await Promise.all([prisma.city.findMany({ orderBy: { name: 'asc' } }), prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } })]);
    return res.render('operacionesPersonalNuevo', { cities, vacancies, role: req.session?.userRole || req.userRole });
  });
  router.post('/personal/nuevo', requireOps, async (req, res) => {
    const fullName = normalizeString(req.body.fullName); if (!fullName) return res.status(400).send('Nombre requerido');
    const cityIds = normalizeStringList(req.body.cityIds); const vacancyIds = normalizeStringList(req.body.vacancyIds);
    const worker = await prisma.dispatchWorker.create({ data: { fullName, phone: normalizeString(req.body.phone), documentType: normalizeString(req.body.documentType), documentNumber: normalizeString(req.body.documentNumber), residenceCity: normalizeString(req.body.residenceCity), residenceLocality: normalizeString(req.body.residenceLocality), transportMode: normalizeString(req.body.transportMode), notes: normalizeString(req.body.notes), source: 'MANUAL', operationalStatus: 'ACTIVE' } });
    if (cityIds.length) await prisma.dispatchWorkerCity.createMany({ data: cityIds.map((cityId) => ({ workerId: worker.id, cityId })), skipDuplicates: true });
    if (vacancyIds.length) await prisma.dispatchWorkerVacancy.createMany({ data: vacancyIds.map((vacancyId) => ({ workerId: worker.id, vacancyId })), skipDuplicates: true });
    return res.redirect('/admin/operaciones/personal');
  });

  router.post('/sync-contratados', requireOps, requireDev, async (_req, res) => { const registered = await prisma.candidate.findMany({ where: { status: 'REGISTRADO' }, select: { id: true } }); for (const candidate of registered) await upsertDispatchWorkerFromCandidate(prisma, candidate.id); return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent(`Modo prueba: sincronización completada con ${registered.length} candidatos registrados procesados.`)}`); });
  router.get('/novedades', requireOps, (_req, res) => renderOperationsDashboard(res, { pageTitle: 'Novedades operativas', activeSection: 'novedades' }));

  router.get('/solicitud/:publicToken', async (req, res) => {
    const operationPoint = await prisma.dispatchOperationPoint.findFirst({ where: { publicToken: req.params.publicToken, isActive: true }, include: { client: true } });
    if (!operationPoint) return res.status(404).send('Link no disponible');
    return res.render('publicDispatchRequest', { operationPoint, success: false });
  });
  router.post('/solicitud/:publicToken', async (req, res) => {
    const operationPoint = await prisma.dispatchOperationPoint.findFirst({ where: { publicToken: req.params.publicToken, isActive: true }, include: { client: true } });
    if (!operationPoint) return res.status(404).send('Link no disponible');
    const requiredWorkersRaw = Number(req.body.requiredWorkers);
    await prisma.dispatchServiceRequest.create({ data: { operationPointId: operationPoint.id, clientName: operationPoint.client.name, operationPointName: operationPoint.name, cityName: operationPoint.cityName, address: operationPoint.address, serviceDate: new Date(req.body.serviceDate), startTime: normalizeString(req.body.startTime), endTime: normalizeString(req.body.endTime), requiredWorkers: Number.isFinite(requiredWorkersRaw) ? Math.max(1, Math.trunc(requiredWorkersRaw)) : 1, notes: normalizeString(req.body.notes), requestedByName: normalizeString(req.body.requestedByName), requestedByPhone: normalizeString(req.body.requestedByPhone), requestedByEmail: normalizeString(req.body.requestedByEmail), source: 'PUBLIC_LINK', status: 'PENDING_ASSIGNMENT' } });
    return res.render('publicDispatchRequest', { operationPoint, success: true });
  });

  return router;
}
