import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { sendDispatchCompletionEmail } from '../services/dispatchCompletionEmail.js';
import { loadUnifiedCityOptions } from '../services/cityOptions.js';
import { normalizeTransportMode } from '../services/transportMode.js';
import { recalculateDispatchServiceRequestStatus } from '../services/dispatchOperationalCoverage.js';
import { deleteDispatchServiceRequestWithPolicy } from '../services/dispatchServiceRequestPolicy.js';
import {
  WORKER_REST_REASONS,
  cancelWorkerRestAssignment,
  loadWorkerRestAssignments,
  saveWorkerRestAssignment
} from '../modules/dispatch-payroll/application/payrollReport.js';
import {
  DISPATCH_WORKER_EXCEL_COLUMNS,
  applyDispatchWorkerImportBatch,
  buildDispatchWorkerImportReview,
  buildDispatchWorkerImportTemplate
} from '../services/dispatchWorkerExcelImport.js';

const TEMPLATE_KEY = 'DISPATCH_ASSIGNMENT_WHATSAPP';
const DEFAULT_ASSIGNMENT_TEMPLATE = 'Hola {{nombre}}, te confirmamos asignacion para {{fecha}} en {{operacion}}. Direccion: {{direccion}}. Horario: {{horaInicio}} - {{horaFin}}. Servicio: {{servicio}}. Cliente: {{cliente}}. Por favor confirma recibido.';
const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const MAX_CV_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_CV_MIME_TYPES = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const ALLOWED_CV_EXTENSIONS = ['.pdf', '.doc', '.docx'];
const ASSIGNMENT_REQUESTS_LOOKBACK_DAYS = 60;

const DISPATCH_OWNED_SOURCES = ['MANUAL', 'EXCEL_IMPORT', 'CANDIDATE'];

// TEMPORAL: lista amplia de estados desactivados para rescatar a Juan Jose Garcia.
// Incluye ELIMINADO y quita restriccion de source.
// Revertir a ['DISABLED', 'INACTIVE'] con source filter despues de reactivarlo.
const DISABLED_STATUSES = ['DISABLED', 'INACTIVE', 'ELIMINADO'];

const MAX_EXCEL_SIZE_BYTES = 5 * 1024 * 1024;
const DISPATCH_WORKER_IMPORT_REVIEW_TTL_MS = 2 * 60 * 60 * 1000;
const ALLOWED_EXCEL_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream'
]);
const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EXCEL_SIZE_BYTES },
  fileFilter(_req, file, callback) {
    const originalName = String(file.originalname || '').toLowerCase();
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (!originalName.endsWith('.xlsx')) return callback(new Error('El archivo debe estar en formato .xlsx.'));
    if (mimeType && !ALLOWED_EXCEL_MIME_TYPES.has(mimeType)) return callback(new Error('El tipo de archivo no corresponde a un Excel .xlsx.'));
    return callback(null, true);
  }
});
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
function dispatchWorkerImportOwnerKey(req) { return normalizeString(req.session?.username || req.username) || String(req.sessionID || 'anonymous-session'); }

function normalizeDispatchContractType(value) {
  const normalized = normalizeString(value);
  return ['DIRECTO', 'CONTRATISTA'].includes(normalized) ? normalized : 'DIRECTO';
}
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
function redirectToAssignment(serviceRequestId, message, dateKey = null) { const params = new URLSearchParams(); if (serviceRequestId) params.set('serviceRequestId', serviceRequestId); if (dateKey) params.set('fecha', dateKey); if (message) params.set('message', message); return `/admin/operaciones/asignaciones?${params.toString()}`; }
function assignmentActor(req) { return { actorUsername: normalizeString(req.session?.username || req.username), actorRole: normalizeString(req.session?.userRole || req.userRole), ipAddress: normalizeString(req.ip), userAgent: normalizeString(req.get?.('user-agent')) }; }
function workerRestErrorMessage(error) {
  const messages = {
    worker_rest_invalid: 'Selecciona auxiliar, fecha y motivo de descanso válidos.',
    worker_rest_worker_not_found: 'El auxiliar ya no existe.',
    worker_rest_direct_contract_required: 'Los descansos solo se pueden asignar a auxiliares con contrato Directo.',
    worker_rest_date_already_assigned: 'El auxiliar ya tiene un descanso activo en esa fecha.',
    worker_rest_origin_sunday_invalid: 'El descanso remunerado debe vincularse a un domingo válido y no festivo.',
    worker_rest_origin_sunday_used: 'Ese domingo ya está vinculado a otro descanso remunerado.',
    worker_rest_not_found: 'El descanso activo ya no existe.'
  };
  return messages[error?.message] || 'No fue posible guardar el descanso.';
}
function todayIsoDate() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })).toISOString().slice(0, 10); }
function normalizeDateParam(value) { const rawValue = normalizeString(value); if (!rawValue) return todayIsoDate(); if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) return todayIsoDate(); return rawValue; }
function buildUtcDayRangeFromDateValue(value) { const start = new Date(value); start.setUTCHours(0, 0, 0, 0); const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1); return { start, end }; }
function serviceRequestServiceData(service) { return { serviceId: service?.id || null, serviceName: service?.name || null }; }
function buildOperationalCityFilter(compatibleOperationalCityIds) { if (!compatibleOperationalCityIds.length) return {}; return { cities: { some: { cityId: { in: compatibleOperationalCityIds } } } }; }
function cleanDistinctStrings(rows, fieldName) { return [...new Set(rows.map((row) => normalizeString(row[fieldName])).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')); }

/**
 * buildDispatchEligibilityFilter
 *
 * TEMPORAL: vista desactivados sin filtro de source — busca cualquier auxiliar
 * con operationalStatus IN DISABLED_STATUSES sin importar source.
 * Revertir despues de rescatar a Juan Jose Garcia.
 */
function buildDispatchEligibilityFilter(status) {
  if (status === 'DISABLED' || status === 'INACTIVE') {
    // TEMPORAL: sin restriccion de source para capturar cualquier valor legacy
    return { operationalStatus: { in: DISABLED_STATUSES } };
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
    contractType: normalizeDispatchContractType(body.contractType),
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
function parseDispatchWorkerExcelUpload(req, res, next) {
  excelUpload.single('excelFile')(req, res, (error) => {
    if (error) {
      req.dispatchWorkerExcelUploadError = error.code === 'LIMIT_FILE_SIZE'
        ? 'El archivo Excel no puede superar 5 MB.'
        : error.message || 'No fue posible recibir el archivo Excel.';
    }
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
  return recalculateDispatchServiceRequestStatus(prisma, serviceRequestId);
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

/**
 * cancelWorkerActiveAssignments
 *
 * Al desactivar un auxiliar, cancela sus asignaciones pendientes
 * (ASSIGNED, CONFIRMATION_PENDING) y marca las CONFIRMED como NO_CONFIRMO
 * para que el operador sepa que necesita buscar reemplazo.
 * Recalcula el estado de cada solicitud afectada.
 */
async function cancelWorkerActiveAssignments(prisma, workerId) {
  const activeAssignments = await prisma.dispatchAssignment.findMany({
    where: { workerId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
    select: { id: true, serviceRequestId: true, status: true }
  });
  if (!activeAssignments.length) return [];

  const affectedRequestIds = [...new Set(activeAssignments.map((a) => a.serviceRequestId))];

  await prisma.$transaction(
    activeAssignments.map((a) =>
      prisma.dispatchAssignment.update({
        where: { id: a.id },
        data: {
          status: a.status === CONFIRMED_ASSIGNMENT_STATUS ? 'NO_CONFIRMO' : 'CANCELLED',
          notes: 'Auxiliar desactivado desde el modulo de personal.'
        }
      })
    )
  );

  await Promise.all(affectedRequestIds.map((id) => recalculateServiceRequestStatus(prisma, id)));

  return affectedRequestIds;
}

export function dispatchOpsExtrasRouter(prisma) {
  const router = express.Router();

  router.get('/asignaciones', requireOps, async (req, res) => {
    const q = normalizeString(req.query.q); const operationalCityId = normalizeString(req.query.operationalCityId); const transportMode = normalizeString(req.query.transportMode); const locality = normalizeString(req.query.locality); const serviceRequestId = normalizeString(req.query.serviceRequestId); const restDate = normalizeDateParam(req.query.fecha || req.query.date || req.query.restDate);
    const compatibleOperationalCityIds = await resolveCompatibleOperationalCityIds(prisma, operationalCityId); const operationalCityFilter = buildOperationalCityFilter(compatibleOperationalCityIds);
    const baseWorkerWhere = { operationalStatus: 'CONTRATADO', ...(q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q, mode: 'insensitive' } }, { phone: { contains: q, mode: 'insensitive' } }] } : {}), ...operationalCityFilter };
    const workerWhere = { ...baseWorkerWhere, ...(transportMode ? { transportMode } : {}), ...(locality ? { residenceLocality: locality } : {}) };
    const localityWhere = { ...baseWorkerWhere, ...(transportMode ? { transportMode } : {}) };
    const transportModeWhere = { ...baseWorkerWhere, ...(locality ? { residenceLocality: locality } : {}) };
    const requestsLookbackDate = new Date();
    requestsLookbackDate.setDate(requestsLookbackDate.getDate() - ASSIGNMENT_REQUESTS_LOOKBACK_DAYS);
    const [workers, cities, transportModeRows, localityRows, serviceRequests, clients, restAssignments] = await Promise.all([
      prisma.dispatchWorker.findMany({ where: workerWhere, include: { cities: { include: { city: true } }, vacancies: { include: { vacancy: true } } }, orderBy: { createdAt: 'desc' } }),
      loadDispatchCities(prisma),
      prisma.dispatchWorker.findMany({ where: transportModeWhere, select: { transportMode: true }, distinct: ['transportMode'], orderBy: { transportMode: 'asc' } }),
      prisma.dispatchWorker.findMany({ where: localityWhere, select: { residenceLocality: true }, distinct: ['residenceLocality'], orderBy: { residenceLocality: 'asc' } }),
      prisma.dispatchServiceRequest.findMany({
        where: { serviceDate: { gte: requestsLookbackDate } },
        include: { service: true, assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }]
      }),
      loadActiveClientsForServiceRequestForm(prisma),
      loadWorkerRestAssignments(prisma, { from: restDate, to: restDate })
    ]);
    const selectedServiceRequest = serviceRequestId ? serviceRequests.find((item) => item.id === serviceRequestId) || null : serviceRequests[0] || null;
    const blockedWorkerIds = new Set(selectedServiceRequest ? selectedServiceRequest.assignments.map((assignment) => assignment.workerId) : []);
    const availableWorkers = workers.filter((worker) => !blockedWorkerIds.has(worker.id));
    const selectedDateRange = selectedServiceRequest ? buildUtcDayRangeFromDateValue(selectedServiceRequest.serviceDate) : null;
    const sameDayAssignments = selectedServiceRequest ? await prisma.dispatchAssignment.findMany({ where: { serviceRequestId: { not: selectedServiceRequest.id }, status: { in: ACTIVE_ASSIGNMENT_STATUSES }, serviceRequest: { serviceDate: { gte: selectedDateRange.start, lt: selectedDateRange.end } } }, select: { workerId: true } }) : [];
    const assignedWorkerIdsOnSelectedDate = new Set(sameDayAssignments.map((assignment) => assignment.workerId));
    return res.render('operacionesAsignacionesConfirmacion', { activeStatuses: ACTIVE_ASSIGNMENT_STATUSES, workers, availableWorkers, assignedWorkerIdsOnSelectedDate, cities, serviceRequests, selectedServiceRequest, selectedServiceRequestId: selectedServiceRequest?.id || '', clients, restDate, restAssignments, restReasons: Object.values(WORKER_REST_REASONS), message: normalizeString(req.query.message), filters: { q: q || '', operationalCityId: operationalCityId || '', transportMode: transportMode || '', locality: locality || '' }, transportModes: cleanDistinctStrings(transportModeRows, 'transportMode'), localities: cleanDistinctStrings(localityRows, 'residenceLocality'), role: req.session?.userRole || req.userRole, canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) });
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

  router.post('/solicitudes/:serviceRequestId/eliminar', requireOps, async (req, res) => {
    const result = await deleteDispatchServiceRequestWithPolicy(prisma, req.params.serviceRequestId);
    if (result.status === 'NOT_FOUND') return res.status(404).send('Solicitud no encontrada');
    if (result.status === 'BLOCKED') {
      return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent(result.policy.deleteBlockedReason)}`);
    }
    const message = result.policy?.isTestClient
      ? 'Solicitud de prueba eliminada sin límite de antigüedad.'
      : 'Solicitud eliminada.';
    return res.redirect(`/admin/operaciones/solicitudes?message=${encodeURIComponent(message)}`);
  });

  router.post('/asignaciones/assign', requireOps, async (req, res) => { const serviceRequestId = normalizeString(req.body.serviceRequestId); const workerId = normalizeString(req.body.workerId); if (!serviceRequestId || !workerId) return res.status(400).send('serviceRequestId y workerId son requeridos'); const [serviceRequest, worker] = await Promise.all([prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId }, select: { id: true, requiredWorkers: true } }), prisma.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true } })]); if (!serviceRequest || !worker) return res.status(404).send('Solicitud o auxiliar no encontrado'); const activeCount = await prisma.dispatchAssignment.count({ where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } } }); if (activeCount >= serviceRequest.requiredWorkers) { await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'La solicitud ya tiene cobertura completa. Espera confirmacion de los auxiliares.')); } const existing = await prisma.dispatchAssignment.findUnique({ where: { serviceRequestId_workerId: { serviceRequestId, workerId } } }); if (existing) { if (ACTIVE_ASSIGNMENT_STATUSES.includes(existing.status)) return res.redirect(redirectToAssignment(serviceRequestId, 'El auxiliar ya esta asignado a esta solicitud.')); await prisma.dispatchAssignment.update({ where: { id: existing.id }, data: { status: 'CONFIRMATION_PENDING', notes: null, createdByUsername: req.session?.username || req.username || null } }); } else { await prisma.dispatchAssignment.create({ data: { serviceRequestId, workerId, status: 'CONFIRMATION_PENDING', createdByUsername: req.session?.username || req.username || null } }); } await recalculateServiceRequestStatus(prisma, serviceRequestId); return res.redirect(redirectToAssignment(serviceRequestId, 'Auxiliar asignado. Queda pendiente de confirmacion.')); });
  router.post('/asignaciones/descansos', requireOps, async (req, res) => {
    const serviceRequestId = normalizeString(req.body.serviceRequestId);
    const restDate = normalizeString(req.body.restDate);
    const workerIds = [...new Set(String(req.body.workerId || '').split(',').map((value) => normalizeString(value)).filter(Boolean))];
    if (!workerIds.length) return res.redirect(redirectToAssignment(serviceRequestId, 'Selecciona al menos un auxiliar para descanso.', restDate));
    let saved = 0;
    const failures = [];
    for (const workerId of workerIds) {
      try {
        await saveWorkerRestAssignment(prisma, { workerId, restDate, reason: req.body.reason, originSundayDate: req.body.originSundayDate, ...assignmentActor(req) });
        saved += 1;
      } catch (error) {
        failures.push(workerRestErrorMessage(error));
      }
    }
    const uniqueFailures = [...new Set(failures)];
    const parts = [];
    if (saved) parts.push(`${saved} descanso${saved !== 1 ? 's asignados' : ' asignado'}`);
    if (failures.length) parts.push(`${failures.length} no guardado${failures.length !== 1 ? 's' : ''}: ${uniqueFailures.join(' · ')}`);
    return res.redirect(redirectToAssignment(serviceRequestId, parts.join('. ') || 'No fue posible guardar el descanso.', restDate));
  });
  router.post('/asignaciones/descansos/cancelar', requireOps, async (req, res) => {
    const serviceRequestId = normalizeString(req.body.serviceRequestId);
    const restDate = normalizeString(req.body.restDate);
    try {
      await cancelWorkerRestAssignment(prisma, { workerId: req.body.workerId, restDate, ...assignmentActor(req) });
      return res.redirect(redirectToAssignment(serviceRequestId, 'Descanso retirado.', restDate));
    } catch (error) {
      return res.redirect(redirectToAssignment(serviceRequestId, workerRestErrorMessage(error), restDate));
    }
  });
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

  router.get('/personal/importar-excel', requireOps, async (req, res) => {
    await prisma.dispatchWorkerImportBatch.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const [cities, vacancies] = await loadWorkerFormLists(prisma);
    return res.render('operacionesPersonalImportar', {
      role: req.session?.userRole || req.userRole,
      message: normalizeString(req.query.message),
      error: normalizeString(req.query.error),
      columns: DISPATCH_WORKER_EXCEL_COLUMNS,
      cities,
      vacancies
    });
  });

  router.get('/personal/importar-excel/plantilla', requireOps, async (_req, res) => {
    const [cities, vacancies] = await loadWorkerFormLists(prisma);
    const workbook = buildDispatchWorkerImportTemplate({ cities, vacancies });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-importacion-auxiliares.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  });

  router.post('/personal/importar-excel', requireOps, parseDispatchWorkerExcelUpload, async (req, res) => {
    if (req.dispatchWorkerExcelUploadError) {
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent(req.dispatchWorkerExcelUploadError));
    }
    if (!req.file) {
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent('Debes seleccionar un archivo Excel .xlsx.'));
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const [cities, vacancies] = await loadWorkerFormLists(prisma);
      const review = await buildDispatchWorkerImportReview({ prisma, workbook, cities, vacancies });
      const now = new Date();
      await prisma.dispatchWorkerImportBatch.deleteMany({ where: { expiresAt: { lt: now } } });
      const batch = await prisma.dispatchWorkerImportBatch.create({
        data: {
          createdByUsername: dispatchWorkerImportOwnerKey(req),
          originalFileName: normalizeString(req.file.originalname),
          status: 'PENDING',
          items: review.items,
          summary: review.summary,
          expiresAt: new Date(now.getTime() + DISPATCH_WORKER_IMPORT_REVIEW_TTL_MS)
        }
      });
      return res.redirect(`/admin/operaciones/personal/importar-excel/${batch.id}/revision`);
    } catch (error) {
      console.error('[Dispatch worker Excel review]', {
        name: error?.name || 'Error',
        statusCode: error?.statusCode || null,
        errorCount: Array.isArray(error?.errors) ? error.errors.length : null
      });
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent(error.message || 'Error al analizar el archivo.'));
    }
  });

  router.get('/personal/importar-excel/:batchId/revision', requireOps, async (req, res) => {
    const ownerKey = dispatchWorkerImportOwnerKey(req);
    const batch = await prisma.dispatchWorkerImportBatch.findFirst({
      where: { id: req.params.batchId, createdByUsername: ownerKey, status: 'PENDING' }
    });
    if (!batch || new Date(batch.expiresAt).getTime() <= Date.now()) {
      if (batch) await prisma.dispatchWorkerImportBatch.delete({ where: { id: batch.id } });
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent('La revisión no existe o expiró. Vuelve a subir el archivo.'));
    }
    return res.render('operacionesPersonalImportarRevision', {
      role: req.session?.userRole || req.userRole,
      batchId: batch.id,
      fileName: batch.originalFileName,
      expiresAt: batch.expiresAt,
      items: Array.isArray(batch.items) ? batch.items : [],
      summary: batch.summary || {}
    });
  });

  router.post('/personal/importar-excel/:batchId/aplicar', requireOps, async (req, res) => {
    try {
      const selectedItemIds = normalizeStringList(req.body.selectedItemIds);
      const result = await applyDispatchWorkerImportBatch({
        prisma,
        batchId: req.params.batchId,
        ownerKey: dispatchWorkerImportOwnerKey(req),
        selectedItemIds,
        applyAll: normalizeString(req.body.applyMode) === 'all'
      });
      const parts = [];
      if (result.created) parts.push(`${result.created} auxiliar${result.created !== 1 ? 'es creados' : ' creado'}`);
      if (result.updated) parts.push(`${result.updated} auxiliar${result.updated !== 1 ? 'es actualizados' : ' actualizado'}`);
      if (result.conflicts) parts.push(`${result.conflicts} omitido${result.conflicts !== 1 ? 's' : ''} porque cambió después de la revisión`);
      return res.redirect('/admin/operaciones/personal?message=' + encodeURIComponent(`Importación aplicada: ${parts.join(', ') || 'sin cambios'}.`));
    } catch (error) {
      return res.redirect('/admin/operaciones/personal/importar-excel?error=' + encodeURIComponent(error.message || 'No fue posible aplicar la revisión.'));
    }
  });

  router.post('/personal/importar-excel/:batchId/cancelar', requireOps, async (req, res) => {
    await prisma.dispatchWorkerImportBatch.deleteMany({
      where: { id: req.params.batchId, createdByUsername: dispatchWorkerImportOwnerKey(req), status: 'PENDING' }
    });
    return res.redirect('/admin/operaciones/personal/importar-excel?message=' + encodeURIComponent('Revisión cancelada. No se aplicó ningún cambio.'));
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
    const [worker, cities, vacancies] = await Promise.all([findWorkerOr404(prisma, req.params.workerId), loadDispatchCities(prisma), prisma.vacancy.findMany({ select: { id: true, title: true, city: true }, orderBy: { title: 'asc' } })]);
    if (!worker) return res.status(404).send('Auxiliar no encontrado');
    return res.render('operacionesPersonalNuevo', { cities, vacancies, worker, mode: 'edit', formAction: `/admin/operaciones/personal/${worker.id}/editar`, role: req.session?.userRole || req.userRole });
  });
  router.post('/personal/:workerId/editar', requireOps, parseWorkerCvUpload, async (req, res) => {
    const existing = await findWorkerOr404(prisma, req.params.workerId);
    if (!existing) return res.status(404).send('Auxiliar no encontrado');
    const workerData = buildWorkerData(req.body);
    const missingFields = validateRequiredWorkerFields(workerData, req.body);
    if (req.workerCvUploadError) return renderWorkerFormWithError(req, res, prisma, { worker: existing, mode: 'edit', formAction: `/admin/operaciones/personal/${existing.id}/editar`, error: req.workerCvUploadError });
    if (missingFields.length) return renderWorkerFormWithError(req, res, prisma, { worker: existing, mode: 'edit', formAction: `/admin/operaciones/personal/${existing.id}/editar`, error: buildRequiredWorkerFieldsMessage(missingFields) });
    try {
      await prisma.dispatchWorker.update({ where: { id: existing.id }, data: applyWorkerCvFile(workerData, req.file) });
      await replaceWorkerRelations(prisma, existing.id, req.body);
      return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar actualizado.')}`);
    } catch (error) {
      console.error('[Worker update]', error);
      return renderWorkerFormWithError(req, res, prisma, { worker: existing, mode: 'edit', formAction: `/admin/operaciones/personal/${existing.id}/editar`, error: 'No fue posible actualizar el auxiliar. Revisa los datos e intenta nuevamente.' });
    }
  });

  router.post('/personal/:workerId/toggle', requireOps, async (req, res) => {
    const worker = await prisma.dispatchWorker.findFirst({
      where: { id: req.params.workerId, source: { in: DISPATCH_OWNED_SOURCES } }
    });
    if (!worker) return res.status(404).send('Auxiliar no encontrado o no editable desde este modulo');
    const isCurrentlyActive = worker.operationalStatus === 'CONTRATADO';
    const nextStatus = isCurrentlyActive ? 'DISABLED' : 'CONTRATADO';

    await prisma.dispatchWorker.update({ where: { id: worker.id }, data: { operationalStatus: nextStatus } });

    if (nextStatus === 'DISABLED') {
      const affectedRequestIds = await cancelWorkerActiveAssignments(prisma, worker.id);
      const affectedCount = affectedRequestIds.length;
      const warningNote = affectedCount > 0
        ? ` Se cancelaron sus asignaciones activas en ${affectedCount} solicitud${affectedCount !== 1 ? 'es' : ''}. Revisa y asigna reemplazos.`
        : '';
      return res.redirect(`/admin/operaciones/personal?status=DISABLED&message=${encodeURIComponent(`Auxiliar desactivado.${warningNote} Puedes reactivarlo desde aqui.`)}`);
    }

    return res.redirect(`/admin/operaciones/personal?message=${encodeURIComponent('Auxiliar reactivado. Ya aparece disponible para asignaciones.')}`);
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
