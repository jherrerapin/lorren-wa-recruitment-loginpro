import {
  buildDispatchServiceDateWhere,
  dispatchServiceDateKey,
  filterDispatchServiceRequestsByDate,
  normalizeDispatchDateParam
} from '../services/dispatchDate.js';
import {
  operationalCityNameInScope,
  resolveOperationalCityScope
} from '../services/operationalAccess.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const ASSIGNMENT_VIEW = 'operacionesAsignacionesConfirmacion';
const ASSIGNMENT_PATH = '/admin/operaciones/asignaciones';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => normalizeString(item)).filter(Boolean))];
}

function requestedOperationalCityIds(query = {}) {
  const ids = normalizeStringList(query.operationalCityIds);
  const legacyId = normalizeString(query.operationalCityId);
  if (legacyId && !ids.includes(legacyId)) ids.push(legacyId);
  return ids;
}

function hasExplicitCitySelection(query = {}) {
  return query.cityFilter === '1'
    || query.cityFilter === 'true'
    || Object.prototype.hasOwnProperty.call(query, 'operationalCityIds')
    || Boolean(normalizeString(query.operationalCityId));
}

function showsAllDates(query = {}) {
  return query.allDates === '1' || query.allDates === 'true';
}

function hasExplicitAssignmentDate(query = {}) {
  return Boolean(normalizeString(query.fecha || query.date));
}

export function assignmentDateFromQuery(query = {}) {
  if (showsAllDates(query)) return null;
  return normalizeDispatchDateParam(query.fecha || query.date);
}

export function addDateToAssignmentRedirect(target, dateKey) {
  if (!dateKey || typeof target !== 'string' || !target.startsWith(ASSIGNMENT_PATH)) return target;
  const url = new URL(target, 'https://lorren.invalid');
  if (!url.searchParams.has('fecha') && !url.searchParams.has('allDates')) {
    url.searchParams.set('fecha', dateKey);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function loadAssignmentDateContext(prisma, selectedDate, requestedServiceRequestId = null, cityScope = null) {
  if (!selectedDate) return null;

  const serviceRequestsRaw = await prisma.dispatchServiceRequest.findMany({
    where: buildDispatchServiceDateWhere(selectedDate),
    include: {
      service: true,
      assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } }
    },
    orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }]
  });
  const serviceRequestsByDate = filterDispatchServiceRequestsByDate(serviceRequestsRaw, selectedDate);
  const serviceRequests = cityScope
    ? serviceRequestsByDate.filter((request) => operationalCityNameInScope(cityScope, request.cityName))
    : serviceRequestsByDate;

  const selectedServiceRequest = requestedServiceRequestId
    ? serviceRequests.find((request) => request.id === requestedServiceRequestId) || serviceRequests[0] || null
    : serviceRequests[0] || null;

  const blockedWorkerIds = new Set(
    selectedServiceRequest ? selectedServiceRequest.assignments.map((assignment) => assignment.workerId) : []
  );

  const sameDayAssignmentsRaw = selectedServiceRequest
    ? await prisma.dispatchAssignment.findMany({
        where: {
          serviceRequestId: { not: selectedServiceRequest.id },
          status: { in: ACTIVE_ASSIGNMENT_STATUSES },
          serviceRequest: { is: buildDispatchServiceDateWhere(selectedDate) }
        },
        select: { workerId: true, serviceRequest: { select: { serviceDate: true, cityName: true } } }
      })
    : [];
  const sameDayAssignments = sameDayAssignmentsRaw.filter((assignment) => (
    dispatchServiceDateKey(assignment.serviceRequest?.serviceDate) === selectedDate
    && (!cityScope || operationalCityNameInScope(cityScope, assignment.serviceRequest?.cityName))
  ));

  return {
    selectedDate,
    serviceRequests,
    selectedServiceRequest,
    blockedWorkerIds,
    assignedWorkerIdsOnSelectedDate: new Set(sameDayAssignments.map((assignment) => assignment.workerId))
  };
}

function installAssignmentRenderGate(req, res, next, selectedDate, context, cityScope) {
  const originalRender = res.render.bind(res);
  res.render = (view, locals, callback) => {
    let renderLocals = locals || {};
    let renderCallback = callback;
    if (typeof locals === 'function') {
      renderCallback = locals;
      renderLocals = {};
    }

    if (view !== ASSIGNMENT_VIEW) return originalRender(view, renderLocals, renderCallback);

    const nextLocals = {
      ...renderLocals,
      selectedAssignmentDate: selectedDate || '',
      operationalCityScope: cityScope || renderLocals.operationalCityScope || null
    };

    if (context) {
      nextLocals.serviceRequests = context.serviceRequests;
      nextLocals.selectedServiceRequest = context.selectedServiceRequest;
      nextLocals.selectedServiceRequestId = context.selectedServiceRequest?.id || '';
      nextLocals.availableWorkers = Array.isArray(renderLocals.workers)
        ? renderLocals.workers.filter((worker) => !context.blockedWorkerIds.has(worker.id))
        : renderLocals.availableWorkers;
      nextLocals.assignedWorkerIdsOnSelectedDate = context.assignedWorkerIdsOnSelectedDate;
      nextLocals.restDate = context.selectedDate;
    }

    return originalRender(view, nextLocals, renderCallback);
  };
}

async function installAssignmentRedirectDate(prisma, req, res, cityScope) {
  const serviceRequestId = normalizeString(req.body?.serviceRequestId);
  if (!serviceRequestId) return true;

  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { serviceDate: true, cityName: true }
  });
  if (!serviceRequest) return true;
  if (cityScope && !operationalCityNameInScope(cityScope, serviceRequest.cityName, { selected: false })) {
    res.status(403).send('No tienes permiso para gestionar asignaciones de esta ciudad.');
    return false;
  }

  const dateKey = dispatchServiceDateKey(serviceRequest.serviceDate);
  if (!dateKey) return true;

  const originalRedirect = res.redirect.bind(res);
  res.redirect = (statusOrUrl, maybeUrl) => {
    if (typeof statusOrUrl === 'number') {
      return originalRedirect(statusOrUrl, addDateToAssignmentRedirect(maybeUrl, dateKey));
    }
    return originalRedirect(addDateToAssignmentRedirect(statusOrUrl, dateKey));
  };
  return true;
}

async function inferAssignmentDateFromRequestedService(prisma, serviceRequestId, cityScope = null) {
  if (!serviceRequestId) return null;
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { serviceDate: true, cityName: true }
  });
  if (cityScope && !operationalCityNameInScope(cityScope, serviceRequest?.cityName)) return null;
  return dispatchServiceDateKey(serviceRequest?.serviceDate);
}

export function dispatchAssignmentDateGuard(prisma) {
  return async function assignmentDateGuard(req, res, next) {
    try {
      if (req.method === 'GET') {
        const query = req.query || {};
        const selectionExplicit = hasExplicitCitySelection(query);
        const cityScope = await resolveOperationalCityScope(prisma, req, {
          requestedCityIds: requestedOperationalCityIds(query),
          selectionExplicit
        });
        req.operationalCityScope = cityScope;
        if (cityScope.unauthorizedRequestedCityIds.length) {
          return res.status(403).send('Una o más ciudades seleccionadas están fuera de tu alcance operativo.');
        }

        const requestedServiceRequestId = normalizeString(query.serviceRequestId);
        let selectedDate = assignmentDateFromQuery(query);

        // Un enlace a una solicitud concreta debe abrir el tablero en la fecha de esa solicitud.
        // Solo inferimos cuando el enlace omitió fecha; una fecha explícita y allDates conservan prioridad.
        if (!showsAllDates(query) && requestedServiceRequestId && !hasExplicitAssignmentDate(query)) {
          selectedDate = await inferAssignmentDateFromRequestedService(prisma, requestedServiceRequestId, cityScope) || selectedDate;
        }

        // La fecha visible y la fecha que consume la ruta activa deben ser la misma.
        // Una entrada completamente vacía sigue resolviendo hoy en America/Bogota.
        if (selectedDate) {
          query.fecha = selectedDate;
          delete query.date;
        }

        const context = selectedDate
          ? await loadAssignmentDateContext(prisma, selectedDate, requestedServiceRequestId, cityScope)
          : null;

        if (context?.selectedServiceRequest) query.serviceRequestId = context.selectedServiceRequest.id;
        else if (selectedDate) delete query.serviceRequestId;

        installAssignmentRenderGate(req, res, next, selectedDate, context, cityScope);
        return next();
      }

      if (req.method === 'POST') {
        const cityScope = await resolveOperationalCityScope(prisma, req);
        req.operationalCityScope = cityScope;
        const allowed = await installAssignmentRedirectDate(prisma, req, res, cityScope);
        if (!allowed) return;
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
