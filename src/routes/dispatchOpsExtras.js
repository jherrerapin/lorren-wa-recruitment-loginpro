import express from 'express';

const TEMPLATE_KEY = 'DISPATCH_ASSIGNMENT_WHATSAPP';
const DEFAULT_ASSIGNMENT_TEMPLATE = 'Hola {{nombre}}, te confirmamos asignacion para {{fecha}} en {{operacion}}. Direccion: {{direccion}}. Horario: {{horaInicio}} - {{horaFin}}. Servicio: {{servicio}}. Cliente: {{cliente}}. Por favor confirma recibido.';
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';

function normalizeString(value) { if (typeof value !== 'string') return null; const trimmed = value.trim(); return trimmed.length ? trimmed : null; }
function normalizeText(value) { return normalizeString(value)?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() || ''; }
function isBogotaSiberiaName(cityName) { const normalized = normalizeText(cityName); return normalized === 'bogota' || normalized === 'bogota d.c.' || normalized === 'bogota dc' || normalized === 'siberia'; }
function isOpsUser(req) { const username = normalizeString(req.session?.username || req.username); return Boolean(username?.startsWith('operaciones-despacho')); }
function canUseOps(req) { const role = req.session?.userRole || req.userRole; const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch); return role === 'dev' || canAccessDispatch || isOpsUser(req); }
function requireOps(req, res, next) { const role = req.session?.userRole || req.userRole; if (!role) return res.redirect('/login'); if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario'); return next(); }
function redirectToAssignment(serviceRequestId, message) { const params = new URLSearchParams(); if (serviceRequestId) params.set('serviceRequestId', serviceRequestId); if (message) params.set('message', message); return `/admin/operaciones/asignaciones?${params.toString()}`; }
function todayIsoDate() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })).toISOString().slice(0, 10); }
function normalizeDateParam(value) { const rawValue = normalizeString(value); if (!rawValue) return todayIsoDate(); if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) return todayIsoDate(); return rawValue; }
function buildUtcDayRange(dateText) { const start = new Date(`${dateText}T00:00:00.000Z`); const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1); return { start, end }; }
function serviceRequestServiceData(service) { return { serviceId: service?.id || null, serviceName: service?.name || null }; }
function buildOperationalCityFilter(compatibleOperationalCityIds) { if (!compatibleOperationalCityIds.length) return {}; return { cities: { some: { cityId: { in: compatibleOperationalCityIds } } } }; }
async function resolveDispatchService(prisma, serviceId) { const normalizedServiceId = normalizeString(serviceId); if (!normalizedServiceId) return null; return prisma.dispatchClientService.findFirst({ where: { id: normalizedServiceId, isActive: true }, include: { client: true } }); }
async function getTemplate(prisma) { const template = await prisma.dispatchMessageTemplate.findUnique({ where: { key: TEMPLATE_KEY } }); return template?.content || DEFAULT_ASSIGNMENT_TEMPLATE; }
async function loadDispatchCities(prisma) { return prisma.city.findMany({ where: { usedForDispatch: true }, orderBy: { name: 'asc' } }); }
async function resolveCompatibleOperationalCityIds(prisma, operationalCityId) {
  if (!operationalCityId) return [];
  const selectedCity = await prisma.city.findFirst({ where: { id: operationalCityId, usedForDispatch: true }, select: { id: true, name: true } });
  if (!selectedCity) return [operationalCityId];
  if (!isBogotaSiberiaName(selectedCity.name)) return [selectedCity.id];
  const cities = await loadDispatchCities(prisma);
  const compatibleIds = cities.filter((city) => isBogotaSiberiaName(city.name)).map((city) => city.id);
  return compatibleIds.length ? compatibleIds : [selectedCity.id];
}

async function recalculateServiceRequestStatus(prisma, serviceRequestId) {
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true, requiredWorkers: true } });
  if (!serviceRequest) return;
  const [activeCount, confirmedCount] = await Promise.all([
    prisma.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }),
    prisma.dispatchAssignment.count({ where: { serviceRequestId, status: CONFIRMED_ASSIGNMENT_STATUS } })
  ]);
  let status = 'PENDING_ASSIGNMENT';
  if (confirmedCount >= serviceRequest.requiredWorkers) status = 'ASSIGNMENT_COMPLETE';
  else if (activeCount >= serviceRequest.requiredWorkers) status = 'PENDING_CONFIRMATION';
  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';
  await prisma.dispatchServiceRequest.update({ where: { id: serviceRequestId }, data: { status } });
}

export function dispatchOpsExtrasRouter(prisma) {
  const router = express.Router();

  router.get('/asignaciones', requireOps, async (req, res) => {
    const q = normalizeString(req.query.q); const operationalCityId = normalizeString(req.query.operationalCityId); const vacancyId = normalizeString(req.query.vacancyId); const transportMode = normalizeString(req.query.transportMode); const locality = normalizeString(req.query.locality); const status = normalizeString(req.query.status); const serviceRequestId = normalizeString(req.query.serviceRequestId);
    const compatibleOperationalCityIds = await resolveCompatibleOperationalCityIds(prisma, operationalCityId); const operationalCityFilter = buildOperationalCityFilter(compatibleOperationalCityIds);
    const workerWhere = { ...(status ? { operationalStatus: status } : {}), ...(q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] } : {}), ...operationalCityFilter, ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}), ...(transportMode ? { transportMode } : {}), ...(locality ? { residenceLocality: locality } : {}) };
    const localityWhere = { ...operationalCityFilter, ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {}), ...(transportMode ? { transportMode } : {}), ...(status ? { operationalStatus: status } : {}) };
    const [workers, cities, vacancies, transportModeRows, localityRows, serviceRequests, clients] = await Promise.all([
      prisma.dispatchWorker.findMany({ where: workerWhere, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } }),
      loadDispatchCities(prisma),
      prisma.vacancy.findMany({ select: { id: true, title: true }, orderBy: { title: 'asc' } }),
      prisma.dispatchWorker.findMany({ select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }),
      prisma.dispatchWorker.findMany({ where: localityWhere, select: { residenceLocality: true }, distinct: ['residenceLocality'], orderBy: { residenceLocality: 'asc' } }),
      prisma.dispatchServiceRequest.findMany({ include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] }),
      prisma.dispatchClient.findMany({ where: { isActive: true }, include: { operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } }, services: { where: { isActive: true }, orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } })
    ]);
    const selectedServiceRequest = serviceRequestId ? serviceRequests.find((item) => item.id === serviceRequestId) || null : serviceRequests[0] || null;
    const blockedWorkerIds = new Set(selectedServiceRequest ? selectedServiceRequest.assignments.map((assignment) => assignment.workerId) : []);
    const availableWorkers = workers.filter((worker) => !blockedWorkerIds.has(worker.id));
    return res.render('operacionesAsignacionesConfirmacion', { activeStatuses: ACTIVE_ASSIGNMENT_STATUSES, workers, availableWorkers, cities, vacancies, serviceRequests, selectedServiceRequest, selectedServiceRequestId: selectedServiceRequest?.id || '', clients, message: normalizeString(req.query.message), filters: { q: q || '', operationalCityId: operationalCityId || '', vacancyId: vacancyId || '', transportMode: transportMode || '', locality: locality || '', status: status || '' }, transportModes: transportModeRows.map((row) => row.transportMode).filter(Boolean), localities: localityRows.map((row) => row.residenceLocality).filter(Boolean), role: req.session?.userRole || req.userRole, canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) });
  });

  router.get('/solicitudes', requireOps, async (req, res) => {
    const [serviceRequests, clients] = await Promise.all([
      prisma.dispatchServiceRequest.findMany({ include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] }),
      prisma.dispatchClient.findMany({ where: { isActive: true }, include: { services: { where: { isActive: true }, orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } })
    ]);
    return res.render('operacionesSolicitudes', { serviceRequests, clients, role: req.session?.userRole || req.userRole, message: normalizeString(req.query.message), today: todayIsoDate() });
  });

  router.post('/solicitudes', requireOps, async (req, res) => {
    const selectedService = await resolveDispatchService(prisma, req.body.serviceId);
    const clientName = selectedService?.client?.name || normalizeString(req.body.clientName);
    const serviceDateRaw = normalizeString(req.body.serviceDate);
    const requiredWorkersRaw = Number(req.body.requiredWorkers);
    if (!clientName || !serviceDateRaw || !Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) return res.status(400).send('Datos invalidos para crear solicitud de servicio');
    const created = await prisma.dispatchServiceRequest.create({ data: { clientName, operationPointName: normalizeString(req.body.operationPointName), cityName: normalizeString(req.body.cityName), address: normalizeString(req.body.address), ...serviceRequestServiceData(selectedService), serviceDate: new Date(serviceDateRaw), startTime: normalizeString(req.body.startTime), endTime: normalizeString(req.body.endTime), requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)), notes: normalizeString(req.body.notes), status: 'PENDING_ASSIGNMENT', source: 'INTERNAL', createdByUsername: req.session?.username || req.username || null } });
    return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent('Solicitud creada.')}&created=${created.id}`);
  });

  router.post('/solicitudes/:serviceRequestId/eliminar', requireOps, async (req, res) => { const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.serviceRequestId }, select: { id: true } }); if (!serviceRequest) return res.status(404).send('Solicitud no encontrada'); await prisma.dispatchServiceRequest.delete({ where: { id: serviceRequest.id } }); return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent('Solicitud eliminada.')}`); });

  router.post('/asignaciones/assign', requireOps, async (req, res) => { const serviceRequestId = normalizeString(req.body.serviceRequestId); const workerId = normalizeString(req.body.workerId); if (!serviceRequestId || !workerId) return res.status(400).send('serviceRequestId y workerId son requeridos'); const [serviceRequest, worker] = await Promise.all([prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true, requiredWorkers: true } }), prisma.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true } })]); if (!serviceRequest || !worker) return res.status(404).send('Solicitud o auxiliar no encontrado'); const activeCount = await prisma.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }); if (activeCount >= serviceRequest.requiredWorkers) { await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'La solicitud ya tiene cobertura completa. Espera confirmación de los auxiliares.')); } const existing = await prisma.dispatchAssignment.findUnique({ where: { serviceRequestId_workerId: { serviceRequestId, workerId } } }); if (existing) { if (ACTIVE_ASSIGNMENT_STATUSES.includes(existing.status)) return res.redirect(redirectToAssignment(serviceRequestId, 'El auxiliar ya está asignado a esta solicitud.')); await prisma.dispatchAssignment.update({ where: { id: existing.id }, data: { status: 'CONFIRMATION_PENDING', notes: null, createdByUsername: req.session?.username || req.username || null } }); } else { await prisma.dispatchAssignment.create({ data: { serviceRequestId, workerId, status: 'CONFIRMATION_PENDING', createdByUsername: req.session?.username || req.username || null } }); } await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'Auxiliar asignado. Queda pendiente de confirmación.')); });
  router.post('/asignaciones/confirmar', requireOps, async (req, res) => { const assignmentId = normalizeString(req.body.assignmentId); const serviceRequestId = normalizeString(req.body.serviceRequestId); if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos'); await prisma.dispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'CONFIRMED', notes: normalizeString(req.body.notes) } }); await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'Confirmación registrada.')); });
  router.post('/asignaciones/no-confirmado', requireOps, async (req, res) => { const assignmentId = normalizeString(req.body.assignmentId); const serviceRequestId = normalizeString(req.body.serviceRequestId); if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos'); await prisma.dispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'NO_CONFIRMO', notes: normalizeString(req.body.notes) || 'El auxiliar no confirmó la asignación.' } }); await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'Auxiliar marcado como no confirmado. Debes asignar reemplazo.')); });
  router.post('/asignaciones/unassign', requireOps, async (req, res) => { const assignmentId = normalizeString(req.body.assignmentId); const serviceRequestId = normalizeString(req.body.serviceRequestId); if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos'); await prisma.dispatchAssignment.delete({ where: { id: assignmentId } }); await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'Auxiliar retirado de la solicitud.')); });

  router.get('/novedades', requireOps, async (req, res) => { const selectedDate = normalizeDateParam(req.query.fecha || req.query.date); const status = normalizeString(req.query.status) || 'OPEN'; const { start, end } = buildUtcDayRange(selectedDate); const incidents = await prisma.dispatchIncident.findMany({ where: { ...(status === 'ALL' ? {} : { status }), serviceRequest: { serviceDate: { gte: start, lt: end } } }, include: { serviceRequest: true, worker: true, assignment: { include: { worker: true } } }, orderBy: { createdAt: 'desc' } }); return res.render('operacionesNovedades', { pageTitle: 'Novedades operativas', selectedDate, status, incidents, role: req.session?.userRole || req.userRole, canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) }); });
  router.get('/api/asignacion-template', requireOps, async (_req, res) => res.json({ key: TEMPLATE_KEY, content: await getTemplate(prisma) }));
  router.post('/asignaciones/template', requireOps, async (req, res) => { const content = normalizeString(req.body.content); if (!content) return res.status(400).json({ error: 'La plantilla no puede estar vacia.' }); const username = req.session?.username || req.username || null; await prisma.dispatchMessageTemplate.upsert({ where: { key: TEMPLATE_KEY }, update: { content, updatedByUsername: username }, create: { key: TEMPLATE_KEY, content, createdByUsername: username, updatedByUsername: username } }); return res.json({ ok: true, content }); });
  router.post('/asignaciones/novedades', requireOps, async (req, res) => { const serviceRequestId = normalizeString(req.body.serviceRequestId); const type = normalizeString(req.body.type); const description = normalizeString(req.body.description); const assignmentId = normalizeString(req.body.assignmentId); const workerId = normalizeString(req.body.workerId); if (!serviceRequestId || !type || !description) return res.status(400).send('Solicitud, tipo y descripcion son requeridos.'); const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true } }); if (!serviceRequest) return res.status(404).send('Solicitud no encontrada'); await prisma.dispatchIncident.create({ data: { serviceRequestId, assignmentId: assignmentId || null, workerId: workerId || null, type, description, reportedBy: normalizeString(req.body.reportedBy), status: 'OPEN', createdByUsername: req.session?.username || req.username || null } }); return res.redirect(redirectToAssignment(serviceRequestId, 'Novedad registrada.')); });
  router.post('/asignaciones/novedades/:incidentId/resolver', requireOps, async (req, res) => { const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true, serviceRequestId: true } }); if (!incident) return res.status(404).send('Novedad no encontrada'); await prisma.dispatchIncident.update({ where: { id: incident.id }, data: { status: 'RESOLVED', resolutionNote: normalizeString(req.body.resolutionNote), resolvedByUsername: req.session?.username || req.username || null, resolvedAt: new Date() } }); return res.redirect(redirectToAssignment(incident.serviceRequestId, 'Novedad resuelta.')); });
  router.post('/novedades/:incidentId/resolver', requireOps, async (req, res) => { const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true } }); if (!incident) return res.status(404).send('Novedad no encontrada'); await prisma.dispatchIncident.update({ where: { id: incident.id }, data: { status: 'RESOLVED', resolutionNote: normalizeString(req.body.resolutionNote), resolvedByUsername: req.session?.username || req.username || null, resolvedAt: new Date() } }); return res.redirect(`/admin/operaciones/novedades?fecha=${encodeURIComponent(normalizeDateParam(req.body.fecha))}&status=${encodeURIComponent(normalizeString(req.body.status) || 'OPEN')}`); });
  router.post('/asignaciones/novedades/:incidentId/reabrir', requireOps, async (req, res) => { const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true, serviceRequestId: true } }); if (!incident) return res.status(404).send('Novedad no encontrada'); await prisma.dispatchIncident.update({ where: { id: incident.id }, data: { status: 'OPEN', resolvedAt: null, resolvedByUsername: null, resolutionNote: null } }); return res.redirect(redirectToAssignment(incident.serviceRequestId, 'Novedad reabierta.')); });
  router.post('/novedades/:incidentId/reabrir', requireOps, async (req, res) => { const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true } }); if (!incident) return res.status(404).send('Novedad no encontrada'); await prisma.dispatchIncident.update({ where: { id: incident.id }, data: { status: 'OPEN', resolvedAt: null, resolvedByUsername: null, resolutionNote: null } }); return res.redirect(`/admin/operaciones/novedades?fecha=${encodeURIComponent(normalizeDateParam(req.body.fecha))}&status=${encodeURIComponent(normalizeString(req.body.status) || 'ALL')}`); });
  return router;
}
