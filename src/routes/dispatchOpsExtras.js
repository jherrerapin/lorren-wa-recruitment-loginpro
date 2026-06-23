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
const MAX_CV_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_CV_MIME_TYPES = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const ALLOWED_CV_EXTENSIONS = ['.pdf', '.doc', '.docx'];
const ASSIGNMENT_REQUESTS_LOOKBACK_DAYS = 60;

// Fuentes que pertenecen al modulo de despacho manual (para toggle/eliminar).
const DISPATCH_OWNED_SOURCES = ['MANUAL', 'EXCEL_IMPORT'];

// TEMPORAL: ELIMINADO incluido para rescatar a Juan Jose Garcia.
// Revertir a ['DISABLED', 'INACTIVE'] despues de reactivarlo.
const DISABLED_STATUSES = ['DISABLED', 'INACTIVE', 'ELIMINADO'];

const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const workerCvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CV_SIZE_BYTES },
  fileFilter(_req, file, callback) {
    const originalName = String(file.originalname || '').toLowerCase();
    const allowedByMime = ALLOWED_CV_MIME_TYPES.has(file.mimetype);
    const allowedByExtension = ALLOWED_CV_EXTENSIONS.some((extension) => originalName.endsWith(extension));
    if (allowedByMime || allowedByExtension) return callback(null, true);
    return callback(new Error('La hoja de vida debe estar en formato PDF, DOC o DOCX.'));
  }
});

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

/**
 * buildDispatchEligibilityFilter — controla que auxiliares se muestran en /personal.
 *
 * Vista activos (default): operationalStatus='CONTRATADO', cualquier source.
 * Vista desactivados (status=DISABLED): operationalStatus IN DISABLED_STATUSES
 *   restringido a source MANUAL o EXCEL_IMPORT.
 *
 * NOTA TEMPORAL: DISABLED_STATUSES incluye 'ELIMINADO' para rescatar a Juan Jose Garcia.
 * Revertir despues de que sea reactivado.
 */
function buildDispatchEligibilityFilter(status) {
  if (status === 'DISABLED' || status === 'INACTIVE') {
    return {
      source: { in: DISPATCH_OWNED_SOURCES },
      operationalStatus: { in: DISABLED_STATUSES }
    };
  }
  return { operationalStatus: 'CONTRATADO' };
}

function buildWorkerData(body = {}) {
  return {
    fullName: normalizeString(body.fullName),
    phone: normalizeString(body.phone),
    documentType: normalizeString(body.documentType),
    documentNumber: normalizeString(body.documentNumber),
    residenceCity: normalizeString(body.residenceCity),
    residenceLocality: normalizeString(body.residenceLocality),
    transportMode: normalizeTransportMode(body.transportMode),
    operationalStatus: normalizeString(body.operationalStatus) || 'CONTRATADO',
    notes: normalizeString(body.notes)
  };
}
function validateRequiredWorkerFields(workerData, body = {}) {
  const missing = [];
  if (!workerData.fullName) missing.push('nombre completo');
  if (!workerData.phone) missing.push('telefono');
  if (!workerData.documentType) missing.push('tipo de documento');
  if (!workerData.documentNumber) missing.push('numero de documento');
  if (!workerData.residenceCity) missing.push('ciudad de residencia');
  if (!workerData.residenceLocality) missing.push('localidad / barrio');
  if (!normalizeString(body.operationalStatus)) missing.push('estado operativo');
  if (!normalizeStringList(body.cityIds).length) missing.push('ciudades operativas');
  if (!normalizeStringList(body.vacancyIds).length) missing.push('vacantes / perfiles');
  return missing;
}
function buildRequiredWorkerFieldsMessage(missingFields) {
  return `Completa los campos obligatorios: ${missingFields.join(', ')}.`;
}
function parseWorkerCvUpload(req, res, next) {
  workerCvUpload.single('cvFile')(req, res, (error) => {
    if (error) req.workerCvUploadError = error.code === 'LIMIT_FILE_SIZE' ? 'La hoja de vida no puede superar 5 MB.' : error.message || 'No fue posible procesar la hoja de vida.';
    return next();
  });
}
function applyWorkerCvFile(workerData, file) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) return workerData;
  return { ...workerData, cvData: file.buffer, cvMimeType: file.mimetype || 'application/octet-stream', cvOriginalName: file.originalname || 'hoja-de-vida' };
}
function buildWorkerFormModelFromBody(body = {}, existing = null) {
  const cityIds = normalizeStringList(body.cityIds);
  const vacancyIds = normalizeStringList(body.vacancyIds);
  return {
    ...(existing || {}),
    ...buildWorkerData(body),
    cities: cityIds.map((cityId) => ({ cityId })),
    vacancies: vacancyIds.map((vacancyId) => ({ vacancyId })),
    cvOriginalName: existing?.cvOriginalName || null,
    candidate: existing?.candidate || null,
    candidateId: existing?.candidateId || null
  };
}
async function loadWorkerFormLists(prisma) {
  return Promise.all([loadDispatchCities(prisma), prisma.vacancy.findMany({ select: { id: true, title: true, city: true }, orderBy: { title: 'asc' } })]);
}
async function renderWorkerFormWithError(req, res, prisma, { worker = null, mode, formAction, error, status = 400 }) {
  const [cities, vacancies] = await loadWorkerFormLists(prisma);
  return res.status(status).render('operacionesPersonalNuevo', { cities, vacancies, worker: buildWorkerFormModelFromBody(req.body, worker), mode, formAction, role: req.session?.userRole || req.userRole, error });
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
  if (result?.reason === 'missing_requested_by_email') return ' Solicitud completa: no se envio correo porque no tiene correo del solicitante.';
  if (result?.reason === 'missing_email_config') return ' Solicitud completa: falta configurar correo de salida.';
  if (result?.error) return ' Solicitud completa: no fue posible enviar el correo al solicitante.';
  return '';
}
async function findWorkerOr404(prisma, workerId) { return prisma.dispatchWorker.findFirst({ where: { id: workerId }, include: { cities: true, vacancies: true } }); }
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

export function dispatchOpsExtrasRouter(prisma) {
  const router = express.Router();

  router.get('/asignaciones', requireOps, async (req, res) => {
    const q = normalizeString(req.query.q); const operationalCityId = normalizeString(req.query.operationalCityId); const transportMode = normalizeString(req.query.transportMode); const locality = normalizeString(req.query.locality); const serviceRequestId = normalizeString(req.query.serviceRequestId);
    const compatibleOperationalCityIds = await resolveCompatibleOperationalCityIds(prisma, operationalCityId); const operationalCityFilter = buildOperationalCityFilter(compatibleOperationalCityIds);
    const baseWorkerWhere = { operationalStatus: 'CONTRATADO', ...(q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] } : {}), ...operationalCityFilter };
    const workerWhere = { ...baseWorkerWhere, ...(transportMode ? { transportMode } : {}), ...(locality ? { residenceLocality: locality } : {}) };
    const localityWhere = { ...baseWorkerWhere, ...(transportMode ? { transportMode } : {}) };
    const transportModeWhere = { ...baseWorkerWhere, ...(locality ? { residenceLocality: locality } : {}) };
    const requestsLookbackDate = new Date();
    requestsLookbackDate.setDate(requestsLookbackDate.getDate() - ASSIGNMENT_REQUESTS_LOOKBACK_DAYS);
    const [workers, cities, transportModeRows, localityRows, serviceRequests, clients] = await Promise.all([
      prisma.dispatchWorker.findMany({ where: workerWhere, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } }),
      loadDispatchCities(prisma),
      prisma.dispatchWorker.findMany({ where: transportModeWhere, select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }),
      prisma.dispatchWorker.findMany({ where: localityWhere, select: { residenceLocality: true }, distinct: ['residenceLocality'], orderBy: { residenceLocality: 'asc' } }),
      prisma.dispatchServiceRequest.findMany({
        where: { serviceDate: { gte: requestsLookbackDate } },
        include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }]
      }),
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
    const [serviceRequests, clients] = await Promise.all([
      prisma.dispatchServiceRequest.findMany({ include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }] }),
      loadActiveClientsForServiceRequestForm(prisma)
    ]);
    return res.render('operacionesSolicitudes', { serviceRequests, clients, role: req.session?.userRole || req.userRole, message: normalizeString(req.query.message), today: todayIsoDate() });
  });

  router.post('/solicitudes', requireOps, async (req, res) => {
    const clientId = normalizeString(req.body.clientId);
    const operationPointId = normalizeString(req.body.operationPointId);
    const serviceId = normalizeString(req.body.serviceId);
    const serviceDateRaw = normalizeString(req.body.serviceDate);
    const requiredWorkersRaw = Number(req.body.requiredWorkers);
    if (!clientId || !operationPointId || !serviceDateRaw || !Number.isFinite(requiredWorkersRaw) || requiredWorkersRaw < 1) return res.status(400).send('Selecciona cliente, punto de operacion, fecha y cantidad valida de auxiliares.');
    const client = await prisma.dispatchClient.findFirst({
      where: { id: clientId, isActive: true },
      include: { operationPoints: { where: { isActive: true } }, services: { where: { isActive: true } } }
    });
    if (!client) return res.status(404).send('Cliente no encontrado o inactivo.');
    const operationPoint = client.operationPoints.find((item) => item.id === operationPointId);
    if (!operationPoint) return res.status(400).send('Debes seleccionar una operacion valida para el cliente.');
    const selectedService = serviceId ? client.services.find((item) => item.id === serviceId) || null : null;
    if (client.services.length && !selectedService) return res.status(400).send('Debes seleccionar un servicio valido para el cliente.');
    const created = await prisma.dispatchServiceRequest.create({ data: { operationPointId: operationPoint.id, clientName: client.name, operationPointName: operationPoint.name, cityName: operationPoint.cityName || client.cityName, address: operationPoint.address || normalizeString(req.body.address), ...serviceRequestServiceData(selectedService), serviceDate: new Date(serviceDateRaw), startTime: normalizeString(req.body.startTime), endTime: normalizeString(req.body.endTime), requiredWorkers: Math.max(1, Math.trunc(requiredWorkersRaw)), notes: normalizeString(req.body.notes), status: 'PENDING_ASSIGNMENT', source: 'INTERNAL', createdByUsername: req.session?.username || req.username || null } });
    return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent('Solicitud creada.')}&created=${created.id}`);
  });

  router.post('/solicitudes/:serviceRequestId/eliminar', requireOps, async (req, res) => { const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: req.params.serviceRequestId }, select: { id: true } }); if (!serviceRequest) return res.status(404).send('Solicitud no encontrada'); await prisma.dispatchServiceRequest.delete({ where: { id: serviceRequest.id } }); return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent('Solicitud eliminada.')}`);
  });

  router.post('/asignaciones/assign', requireOps, async (req, res) => { const serviceRequestId = normalizeString(req.body.serviceRequestId); const workerId = normalizeString(req.body.workerId); if (!serviceRequestId || !workerId) return res.status(400).send('serviceRequestId y workerId son requeridos'); const [serviceRequest, worker] = await Promise.all([prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true, requiredWorkers: true } }), prisma.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true } })]); if (!serviceRequest || !worker) return res.status(404).send('Solicitud o auxiliar no encontrado'); const activeCount = await prisma.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }); if (activeCount >= serviceRequest.requiredWorkers) { await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'La solicitud ya tiene cobertura completa. Espera confirmacion de los auxiliares.')); } const existing = await prisma.dispatchAssignment.findUnique({ where: { serviceRequestId_workerId: { serviceRequestId, workerId } } }); if (existing) { if (ACTIVE_ASSIGNMENT_STATUSES.includes(existing.status)) return res.redirect(redirectToAssignment(serviceRequestId, 'El auxiliar ya esta asignado a esta solicitud.')); await prisma.dispatchAssignment.update({ where: { id: existing.id }, data: { status: 'CONFIRMATION_PENDING', notes: null, createdByUsername: req.session?.username || req.username || null } }); } else { await prisma.dispatchAssignment.create({ data: { serviceRequestId, workerId, status: 'CONFIRMATION_PENDING', createdByUsername: req.session?.username || req.username || null } }); } await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'Auxiliar asignado. Queda pendiente de confirmacion.')); });
  router.post('/asignaciones/confirmar', requireOps, async (req, res) => {
    const assignmentId = normalizeString(req.body.assignmentId);
    const serviceRequestId = normalizeString(req.body.serviceRequestId);
    if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos');
    const actorUsername = normalizeString(req.session?.username || req.username);
    await prisma.dispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'CONFIRMED', notes: normalizeString(req.body.notes) } });
    const statusResult = await recalculateServiceRequestStatus(prisma, serviceRequestId);
    const emailMessage = statusResult?.status === 'ASSIGNMENT_COMPLETE'
      ? await notifyIfServiceRequestCompleted(prisma, serviceRequestId, actorUsername)
      : '';
    return res.redirect(redirectToAssignment(serviceRequestId, `Confirmacion registrada.${emailMessage}`));
  });
  router.post('/asignaciones/no-confirmado', requireOps, async (req, res) => { const assignmentId = normalizeString(req.body.assignmentId); const serviceRequestId = normalizeString(req.body.serviceRequestId); if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos'); await prisma.dispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'NO_CONFIRMO', notes: normalizeString(req.body.notes) || 'El auxiliar no confirmo la asignacion.' } }); await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'Auxiliar marcado como no confirmado. Debes asignar reemplazo.')); });
  router.post('/asignaciones/unassign', requireOps, async (req, res) => { const assignmentId = normalizeString(req.body.assignmentId); const serviceRequestId = normalizeString(req.body.serviceRequestId); if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos'); await prisma.dispatchAssignment.delete({ where: { id: assignmentId } }); await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'Auxiliar retirado de la solicitud.')); });

  router.get('/novedades', requireOps, async (req, res) => { const selectedDate = normalizeDateParam(req.query.fecha || req.query.date); const status = normalizeString(req.query.status) || 'OPEN'; const { start, end } = buildUtcDayRange(selectedDate); const incidents = await prisma.dispatchIncident.findMany({ where: { ...(status === 'ALL' ? {} : { status }), serviceRequest: { serviceDate: { gte: start, lt: end } } }, include: { serviceRequest: true, worker: true, assignment: { include: { worker: true } } }, orderBy: { createdAt: 'desc' } }); return res.render('operacionesNovedades', { pageTitle: 'Novedades operativas', selectedDate, status, incidents, role: req.session?.userRole || req.userRole, canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) }); });

  router.get('/api/asignacion-template', requireOps, async (_req, res) => res.json({ key: TEMPLATE_KEY, content: await getTemplate(prisma) }));
  router.post('/asignaciones/template', requireOps, async (req, res) => { const content = normalizeString(req.body.content); if (!content) return res.status(400).json({ error: 'La plantilla no puede estar vacia.' }); const username = req.session?.username || req.username || null; await prisma.dispatchMessageTemplate.upsert({ where: { key: TEMPLATE_KEY }, update: { content, updatedByUsername: username }, create: { key: TEMPLATE_KEY, content, createdByUsername: username, updatedByUsername: username } }); return res.json({ ok: true, content }); });
  router.post('/asignaciones/novedades', requireOps, async (req, res) => { const serviceRequestId = normalizeString(req.body.serviceRequestId); const type = normalizeString(req.body.type); const description = normalizeString(req.body.description); const assignmentId = normalizeString(req.body.assignmentId); const workerId = normalizeString(req.body.workerId); if (!serviceRequestId || !type || !description) return res.status(400).send('Solicitud, tipo y descripcion son requeridos.'); const serviceRequest = await prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true } }); if (!serviceRequest) return res.status(404).send('Solicitud no encontrada'); await prisma.dispatchIncident.create({ data: { serviceRequestId, assignmentId: assignmentId || null, workerId: workerId || null, type, description, reportedBy: normalizeString(req.body.reportedBy), status: 'OPEN', createdByUsername: req.session?.username || req.username || null } }); return res.redirect(redirectToAssignment(serviceRequestId, 'Novedad registrada.')); });
  router.post('/asignaciones/novedades/:incidentId/resolver', requireOps, async (req, res) => { const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true, serviceRequestId: true } }); if (!incident) return res.status(404).send('Novedad no encontrada'); await prisma.dispatchIncident.update({ where: { id: incident.id }, data: { status: 'RESOLVED', resolutionNote: normalizeString(req.body.resolutionNote), resolvedByUsername: req.session?.username || req.username || null, resolvedAt: new Date() } }); return res.redirect(redirectToAssignment(incident.serviceRequestId, 'Novedad resuelta.')); });
  router.post('/novedades/:incidentId/resolver', requireOps, async (req, res) => { const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true } }); if (!incident) return res.status(404).send('Novedad no encontrada'); await prisma.dispatchIncident.update({ where: { id: incident.id }, data: { status: 'RESOLVED', resolutionNote: normalizeString(req.body.resolutionNote), resolvedByUsername: req.session?.username || req.username || null, resolvedAt: new Date() } }); return res.redirect(`/admin/operaciones/novedades?fecha=${encodeURIComponent(normalizeDateParam(req.body.fecha))}&status=${encodeURIComponent(normalizeString(req.body.status) || 'OPEN')}`); });
  router.post('/asignaciones/novedades/:incidentId/reabrir', requireOps, async (req, res) => { const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true, serviceRequestId: true } }); if (!incident) return res.status(404).send('Novedad no encontrada'); await prisma.dispatchIncident.update({ where: { id: incident.id }, data: { status: 'OPEN', resolvedAt: null, resolvedByUsername: null, resolutionNote: null } }); return res.redirect(redirectToAssignment(incident.serviceRequestId, 'Novedad reabierta.')); });
  router.post('/novedades/:incidentId/reabrir', requireOps, async (req, res) => { const incident = await prisma.dispatchIncident.findUnique({ where: { id: req.params.incidentId }, select: { id: true } }); if (!incident) return res.status(404).send('Novedad no encontrada'); await prisma.dispatchIncident.update({ where: { id: incident.id }, data: { status: 'OPEN', resolvedAt: null, resolvedByUsername: null, resolutionNote: null } }); return res.redirect(`/admin/operaciones/novedades?fecha=${encodeURIComponent(normalizeDateParam(req.body.fecha))}&status=${encodeURIComponent(normalizeString(req.body.status) || 'ALL')}`); });

  router.get('/personal', requireOps, async (req, res) => {
    const operationalCityId = normalizeString(req.query.operationalCityId);
    const vacancyId = normalizeString(req.query.vacancyId);
    const status = normalizeString(req.query.status);
    const eligibilityFilter = buildDispatchEligibilityFilter(status);
    const [workers, cities, vacancies] = await Promise.all([
      prisma.dispatchWorker.findMany({
        where: {
          ...eligibilityFilter,
          ...(operationalCityId ? { cities: { some: { cityId: operationalCityId } } } : {}),
          ...(vacancyId ? { vacancies: { some: { vacancyId } } } : {})
        },
        include: { candidate: true, cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } },
        orderBy: { createdAt: 'desc' }
      }),
      loadDispatchCities(prisma),
      prisma.vacancy.findMany({ select: { id: true, title: true, city: true }, orderBy: { title: 'asc' } })
    ]);
    return res.render('operacionesPersonal', {
      pageTitle: 'Personal operativo',
      subtitle: 'Equipo disponible para asignacion.',
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

  router.get('/personal/importar-excel', requireOps, (req, res) => {
    return res.render('operacionesPersonalImportar', {
      role: req.session?.userRole || req.userRole,
      message: normalizeString(req.query.message),
      error: normalizeString(req.query.error)
    });
  });

  router.post('/personal/importar-excel', requireOps, excelUpload.single('excelFile'), async (req, res) => {
    if (!req.file) return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent('Debes seleccionar un archivo Excel.'));
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) throw new Error('El archivo no tiene hojas de calculo.');
      const rows = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const getCellText = (col) => {
          const cell = row.getCell(col);
          const val = cell.value;
          if (val === null || val === undefined) return null;
          if (typeof val === 'object' && val.richText) return val.richText.map((r) => r.text).join('');
          if (typeof val === 'number') return String(Math.round(val));
          return normalizeString(String(val));
        };
        const nombre = getCellText(1); const cedula = getCellText(2); const telefono = getCellText(3); const localidad = getCellText(4);
        if (nombre) rows.push({ nombre, cedula, telefono, localidad });
      });
      if (!rows.length) throw new Error('El archivo no contiene datos validos (recuerda que la primera fila se trata como encabezado).');
      let creados = 0, omitidos = 0, reactivados = 0;
      for (const row of rows) {
        if (row.cedula) {
          const activeExisting = await prisma.dispatchWorker.findFirst({
            where: { documentNumber: row.cedula, operationalStatus: 'CONTRATADO' },
            select: { id: true }
          });
          if (activeExisting) { omitidos++; continue; }
          const disabledExisting = await prisma.dispatchWorker.findFirst({
            where: { documentNumber: row.cedula, source: { in: DISPATCH_OWNED_SOURCES }, operationalStatus: { in: DISABLED_STATUSES } },
            select: { id: true }
          });
          if (disabledExisting) {
            await prisma.dispatchWorker.update({
              where: { id: disabledExisting.id },
              data: { fullName: row.nombre, phone: row.telefono || null, residenceLocality: row.localidad || null, operationalStatus: 'CONTRATADO', source: 'EXCEL_IMPORT' }
            });
            reactivados++;
            continue;
          }
        }
        await prisma.dispatchWorker.create({ data: { fullName: row.nombre, documentNumber: row.cedula || null, phone: row.telefono || null, residenceLocality: row.localidad || null, source: 'EXCEL_IMPORT', operationalStatus: 'CONTRATADO' } });
        creados++;
      }
      const parts = [];
      if (creados) parts.push(`${creados} auxiliar${creados !== 1 ? 'es creados' : ' creado'}`);
      if (reactivados) parts.push(`${reactivados} reactivado${reactivados !== 1 ? 's' : ''}`);
      if (omitidos) parts.push(`${omitidos} omitido${omitidos !== 1 ? 's' : ''} por cedula ya activa`);
      const summary = parts.length ? parts.join(', ') : 'Sin cambios';
      return res.redirect('/admin/operaciones/personal?message=' + encodeURIComponent(`Importacion completada: ${summary}.`));
    } catch (error) {
      console.error('[Excel import]', error);
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent(error.message || 'Error al procesar el archivo.'));
    }
  });

  router.get('/personal/nuevo', requireOps, async (req, res) => {
    const [cities, vacancies] = await loadWorkerFormLists(prisma);
    return res.render('operacionesPersonalNuevo', { cities, vacancies, worker: null, mode: 'create', formAction: '/admin/operaciones/personal/nuevo', role: req.session?.userRole || req.userRole });
  });
  router.post('/personal/nuevo', requireOps, parseWorkerCvUpload, async (req, res) => {
    const workerData = buildWorkerData(req.body);
    const missingFields = validateRequiredWorkerFields(workerData, req.body);
    if (req.workerCvUploadError) return renderWorkerFormWithError(req, res, prisma, { mode: 'create', formAction: '/admin/operaciones/personal/nuevo', error: req.workerCvUploadError });
    if (missingFields.length) return renderWorkerFormWithError(req, res, prisma, { mode: 'create', formAction: '/admin/operaciones/personal/nuevo', error: buildRequiredWorkerFieldsMessage(missingFields) });
    try {
      const worker = await prisma.dispatchWorker.create({ data: { ...applyWorkerCvFile(workerData, req.file), source: 'MANUAL' } });
      await replaceWorkerRelations(prisma, worker.id, req.body);
      return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar manual creado.')}`);
    } catch (error) {
      console.error('[Manual worker create]', error);
      return renderWorkerFormWithError(req, res, prisma, { mode: 'create', formAction: '/admin/operaciones/personal/nuevo', error: 'No fue posible crear el auxiliar. Revisa los datos e intenta nuevamente.' });
    }
  });
  router.get('/personal/:workerId/editar', requireOps, async (req, res) => {
    const [worker, cities, vacancies] = await Promise.all([findManualWorkerOr404(prisma, req.params.workerId), loadDispatchCities(prisma), prisma.vacancy.findMany({ select: { id: true, title: true, city: true }, orderBy: { title: 'asc' } })]);
    if (!worker) return res.status(404).send('Auxiliar manual no encontrado');
    return res.render('operacionesPersonalNuevo', { cities, vacancies, worker, mode: 'edit', formAction: `/admin/operaciones/personal/${worker.id}/editar`, role: req.session?.userRole || req.userRole });
  });
  router.post('/personal/:workerId/editar', requireOps, parseWorkerCvUpload, async (req, res) => {
    const existing = await findManualWorkerOr404(prisma, req.params.workerId);
    if (!existing) return res.status(404).send('Auxiliar manual no encontrado');
    const workerData = buildWorkerData(req.body);
    const missingFields = validateRequiredWorkerFields(workerData, req.body);
    if (req.workerCvUploadError) return renderWorkerFormWithError(req, res, prisma, { worker: existing, mode: 'edit', formAction: `/admin/operaciones/personal/${existing.id}/editar`, error: req.workerCvUploadError });
    if (missingFields.length) return renderWorkerFormWithError(req, res, prisma, { worker: existing, mode: 'edit', formAction: `/admin/operaciones/personal/${existing.id}/editar`, error: buildRequiredWorkerFieldsMessage(missingFields) });
    try {
      await prisma.dispatchWorker.update({ where: { id: existing.id }, data: applyWorkerCvFile(workerData, req.file) });
      await replaceWorkerRelations(prisma, existing.id, req.body);
      return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar manual actualizado.')}`);
    } catch (error) {
      console.error('[Manual worker update]', error);
      return renderWorkerFormWithError(req, res, prisma, { worker: existing, mode: 'edit', formAction: `/admin/operaciones/personal/${existing.id}/editar`, error: 'No fue posible actualizar el auxiliar. Revisa los datos e intenta nuevamente.' });
    }
  });

  /**
   * Toggle activar/desactivar auxiliar.
   * Solo aplica a auxiliares MANUAL o EXCEL_IMPORT.
   * Al reactivar cualquier status en DISABLED_STATUSES lo mueve a CONTRATADO.
   */
  router.post('/personal/:workerId/toggle', requireOps, async (req, res) => {
    const worker = await prisma.dispatchWorker.findFirst({
      where: { id: req.params.workerId, source: { in: DISPATCH_OWNED_SOURCES } }
    });
    if (!worker) return res.status(404).send('Auxiliar no encontrado o no editable desde este modulo');
    const isCurrentlyActive = worker.operationalStatus === 'CONTRATADO';
    const nextStatus = isCurrentlyActive ? 'DISABLED' : 'CONTRATADO';
    await prisma.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: nextStatus } });
    if (nextStatus === 'CONTRATADO') {
      return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar reactivado. Ya aparece disponible para asignaciones.')}`);
    }
    return res.redirect(`/admin/operaciones/personal?status=DISABLED&message=${encodeURIComponent('Auxiliar desactivado. Aparece en la lista de desactivados. Puedes reactivarlo desde aqui.')}`);
  });

  router.post('/personal/:workerId/eliminar', requireOps, async (req, res) => {
    const worker = await prisma.dispatchWorker.findFirst({
      where: { id: req.params.workerId, source: { in: DISPATCH_OWNED_SOURCES } },
      select: { id: true, fullName: true }
    });
    if (!worker) return res.status(404).send('Auxiliar no encontrado o no eliminable desde este modulo');
    const activeAssignmentCount = await prisma.dispatchAssignment.count({
      where: { workerId: worker.id, status: { in: ACTIVE_ASSIGNMENT_STATUSES } }
    });
    if (activeAssignmentCount > 0) {
      const backUrl = normalizeString(req.headers.referer) || '/admin/operaciones/personal?status=DISABLED';
      const sep = backUrl.includes('?') ? '&' : '?';
      return res.redirect(`${backUrl}${sep}message=${encodeURIComponent(`No se puede eliminar: ${worker.fullName} tiene ${activeAssignmentCount} asignacion${activeAssignmentCount !== 1 ? 'es' : ''} activa${activeAssignmentCount !== 1 ? 's' : ''}. Retirarla primero.`)}`);
    }
    await prisma.dispatchWorker.delete({ where: { id: worker.id } });
    return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar eliminado permanentemente.')}`);
  });

  router.post('/personal/eliminar-bulk', requireOps, async (req, res) => {
    const idsRaw = normalizeString(req.body.ids);
    if (!idsRaw) return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('No se recibieron IDs para eliminar.')}`);
    const ids = idsRaw.split(',').map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('No se recibieron IDs validos.')}`);
    const workers = await prisma.dispatchWorker.findMany({
      where: { id: { in: ids }, source: { in: DISPATCH_OWNED_SOURCES } },
      select: { id: true, fullName: true }
    });
    let eliminados = 0;
    let omitidos = 0;
    for (const worker of workers) {
      const activeCount = await prisma.dispatchAssignment.count({
        where: { workerId: worker.id, status: { in: ACTIVE_ASSIGNMENT_STATUSES } }
      });
      if (activeCount > 0) { omitidos++; continue; }
      await prisma.dispatchWorker.delete({ where: { id: worker.id } });
      eliminados++;
    }
    const parts = [];
    if (eliminados) parts.push(`${eliminados} auxiliar${eliminados !== 1 ? 'es eliminados' : ' eliminado'} permanentemente`);
    if (omitidos) parts.push(`${omitidos} omitido${omitidos !== 1 ? 's' : ''} por tener asignaciones activas`);
    return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent(parts.join('. ') || 'Sin cambios.')}`);
  });

  router.post('/sync-contratados', requireOps, requireDev, async (req, res) => {
    const { upsertDispatchWorkerFromCandidate } = await import('../services/dispatchWorkerSync.js');
    const contratados = await prisma.candidate.findMany({ where: { status: 'CONTRATADO' }, select: { id: true } });
    for (const candidate of contratados) await upsertDispatchWorkerFromCandidate(prisma, candidate.id);
    return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent(`Sincronizacion completada: ${contratados.length} candidatos contratados procesados.`)}`);
  });

  return router;
}

function buildUtcDayRange(dateText) { const start = new Date(`${dateText}T00:00:00.000Z`); const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1); return { start, end }; }
