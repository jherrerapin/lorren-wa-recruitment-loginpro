import {
  buildDispatchServiceDateWhere,
  dispatchServiceDateKey,
  filterDispatchServiceRequestsByDate,
  normalizeDispatchDateParam
} from '../services/dispatchDate.js';
import {
  filterOperationalClientsByCityScope,
  operationalCityNamesEquivalent,
  operationalCityScopeAllowsName,
  resolveUserCityScope
} from '../services/cityOptions.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const ASSIGNMENT_VIEW = 'operacionesAsignacionesConfirmacion';
const ASSIGNMENT_EDIT_VIEW = 'operacionesSolicitudEditar';
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

async function resolveAssignmentCityScope(prisma, req, { requestedCityIds = [], selectionExplicit = false } = {}) {
  return resolveUserCityScope(prisma, req, { requestedCityIds, selectionExplicit });
}

function workerMatchesCity(worker, cityName) {
  if (!worker || !normalizeString(cityName)) return false;
  return (worker.cities || []).some((entry) => operationalCityNamesEquivalent(entry?.city?.name, cityName));
}

function assignmentEditRequestId(req = {}) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const match = path.match(/^\/admin\/operaciones\/asignaciones\/solicitudes\/([^/]+)\/editar\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
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
    ? serviceRequestsByDate.filter((request) => operationalCityScopeAllowsName(cityScope, request.cityName))
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
  const sameDayAssignments = sameDayAssignmentsRaw.filter(
    (assignment) => dispatchServiceDateKey(assignment.serviceRequest?.serviceDate) === selectedDate
      && (!cityScope || operationalCityScopeAllowsName(cityScope, assignment.serviceRequest?.cityName))
  );

  return {
    selectedDate,
    serviceRequests,
    selectedServiceRequest,
    blockedWorkerIds,
    assignedWorkerIdsOnSelectedDate: new Set(sameDayAssignments.map((assignment) => assignment.workerId))
  };
}

function filterWorkersByCityScope(workers, cityScope) {
  if (!Array.isArray(workers) || !cityScope) return workers;
  if (!cityScope.restricted && cityScope.selectionExplicit !== true) return workers;
  return workers.filter((worker) => (
    (worker.cities || []).some((entry) => (
      (cityScope.selectedCities || []).some((city) => operationalCityNamesEquivalent(city?.name, entry?.city?.name))
    ))
  ));
}

function installAssignmentRenderGate(req, res, selectedDate, context, cityScope) {
  const originalRender = res.render.bind(res);
  res.render = (view, locals, callback) => {
    let renderLocals = locals || {};
    let renderCallback = callback;
    if (typeof locals === 'function') {
      renderCallback = locals;
      renderLocals = {};
    }

    if (view !== ASSIGNMENT_VIEW) return originalRender(view, renderLocals, renderCallback);

    const scopedWorkers = filterWorkersByCityScope(renderLocals.workers, cityScope) || [];
    const scopedAvailableWorkers = filterWorkersByCityScope(renderLocals.availableWorkers, cityScope) || [];
    const nextLocals = {
      ...renderLocals,
      workers: scopedWorkers,
      availableWorkers: scopedAvailableWorkers,
      cities: cityScope?.allowedCities || renderLocals.cities,
      operationalCityScope: cityScope || renderLocals.operationalCityScope || null,
      selectedAssignmentDate: selectedDate || '',
      transportModes: [...new Set(scopedWorkers.map((worker) => normalizeString(worker.transportMode)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
      localities: [...new Set(scopedWorkers.map((worker) => normalizeString(worker.residenceLocality)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
      filters: {
        ...(renderLocals.filters || {}),
        operationalCityIds: cityScope?.selectedCityIds || [],
        cityFilterExplicit: cityScope?.selectionExplicit === true
      }
    };

    if (context) {
      const requestCity = context.selectedServiceRequest?.cityName || null;
      const requestCityWorkers = requestCity
        ? scopedWorkers.filter((worker) => workerMatchesCity(worker, requestCity))
        : scopedWorkers;
      nextLocals.serviceRequests = context.serviceRequests;
      nextLocals.selectedServiceRequest = context.selectedServiceRequest;
      nextLocals.selectedServiceRequestId = context.selectedServiceRequest?.id || '';
      nextLocals.availableWorkers = requestCityWorkers.filter((worker) => !context.blockedWorkerIds.has(worker.id));
      nextLocals.assignedWorkerIdsOnSelectedDate = context.assignedWorkerIdsOnSelectedDate;
      nextLocals.restDate = context.selectedDate;
    } else if (Array.isArray(renderLocals.serviceRequests)) {
      nextLocals.serviceRequests = renderLocals.serviceRequests.filter((request) => operationalCityScopeAllowsName(cityScope, request.cityName));
      const requestedId = normalizeString(req.query?.serviceRequestId);
      nextLocals.selectedServiceRequest = requestedId
        ? nextLocals.serviceRequests.find((request) => request.id === requestedId) || nextLocals.serviceRequests[0] || null
        : nextLocals.serviceRequests[0] || null;
      nextLocals.selectedServiceRequestId = nextLocals.selectedServiceRequest?.id || '';
    }

    return originalRender(view, nextLocals, renderCallback);
  };
}

function installAssignmentEditRenderGate(res, cityScope) {
  const originalRender = res.render.bind(res);
  res.render = (view, locals, callback) => {
    let renderLocals = locals || {};
    let renderCallback = callback;
    if (typeof locals === 'function') {
      renderCallback = locals;
      renderLocals = {};
    }
    if (view !== ASSIGNMENT_EDIT_VIEW) return originalRender(view, renderLocals, renderCallback);
    return originalRender(view, {
      ...renderLocals,
      clients: filterOperationalClientsByCityScope(renderLocals.clients, cityScope, { selected: false }),
      operationalCityScope: cityScope
    }, renderCallback);
  };
}

async function enforceAssignmentEditScope(prisma, req, res, cityScope) {
  const requestId = assignmentEditRequestId(req);
  if (!requestId) return true;

  const currentRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: requestId },
    select: { id: true, cityName: true }
  });
  if (currentRequest && !operationalCityScopeAllowsName(cityScope, currentRequest.cityName, { selected: false })) {
    res.status(403).send('No tienes permiso para editar solicitudes de esta ciudad.');
    return false;
  }

  if (req.method !== 'POST') {
    installAssignmentEditRenderGate(res, cityScope);
    return true;
  }

  const clientId = normalizeString(req.body?.clientId);
  const operationPointId = normalizeString(req.body?.operationPointId);
  if (!clientId || !operationPointId) return true;
  const client = await prisma.dispatchClient.findFirst({
    where: { id: clientId, isActive: true },
    select: {
      cityName: true,
      operationPoints: {
        where: { id: operationPointId, isActive: true },
        select: { id: true, cityName: true }
      }
    }
  });
  const operationPoint = client?.operationPoints?.[0] || null;
  if (!client || !operationPoint) return true;
  const nextCityName = operationPoint.cityName || client.cityName;
  if (!operationalCityScopeAllowsName(cityScope, nextCityName, { selected: false })) {
    res.status(403).send('No tienes permiso para mover la solicitud a esta ciudad.');
    return false;
  }
  return true;
}

async function installAssignmentRedirectDate(prisma, req, res, cityScope) {
  const serviceRequestId = normalizeString(req.body?.serviceRequestId);
  if (!serviceRequestId) return true;

  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { serviceDate: true, cityName: true }
  });
  if (!serviceRequest) return true;
  if (cityScope && !operationalCityScopeAllowsName(cityScope, serviceRequest.cityName, { selected: false })) {
    res.status(403).send('No tienes permiso para gestionar asignaciones de esta ciudad.');
    return false;
  }

  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const workerId = path.endsWith('/asignaciones/assign') ? normalizeString(req.body?.workerId) : null;
  if (workerId && normalizeString(serviceRequest.cityName)) {
    const worker = await prisma.dispatchWorker.findUnique({
      where: { id: workerId },
      select: { cities: { select: { city: { select: { name: true } } } } }
    });
    if (worker && !workerMatchesCity(worker, serviceRequest.cityName)) {
      res.status(403).send('El auxiliar no está habilitado para la ciudad de esta solicitud.');
      return false;
    }
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
  if (cityScope && !operationalCityScopeAllowsName(cityScope, serviceRequest?.cityName)) return null;
  return dispatchServiceDateKey(serviceRequest?.serviceDate);
}

export function dispatchAssignmentDateGuard(prisma) {
  return async function assignmentDateGuard(req, res, next) {
    try {
      if (req.method === 'GET') {
        const query = req.query || {};
        const editRequestId = assignmentEditRequestId(req);
        if (editRequestId) {
          const cityScope = await resolveAssignmentCityScope(prisma, req);
          req.operationalCityScope = cityScope;
          if (!await enforceAssignmentEditScope(prisma, req, res, cityScope)) return;
          return next();
        }

        const selectionExplicit = hasExplicitCitySelection(query);
        const cityScope = await resolveAssignmentCityScope(prisma, req, {
          requestedCityIds: requestedOperationalCityIds(query),
          selectionExplicit
        });
        req.operationalCityScope = cityScope;
        if (cityScope.unauthorizedRequestedCityIds.length) {
          return res.status(403).send('Una o más ciudades seleccionadas están fuera de tu alcance territorial.');
        }

        const requestedServiceRequestId = normalizeString(query.serviceRequestId);
        let selectedDate = assignmentDateFromQuery(query);

        if (!showsAllDates(query) && requestedServiceRequestId && !hasExplicitAssignmentDate(query)) {
          selectedDate = await inferAssignmentDateFromRequestedService(prisma, requestedServiceRequestId, cityScope) || selectedDate;
        }

        if (selectedDate) {
          query.fecha = selectedDate;
          delete query.date;
        }

        const context = selectedDate
          ? await loadAssignmentDateContext(prisma, selectedDate, requestedServiceRequestId, cityScope)
          : null;

        if (context?.selectedServiceRequest) query.serviceRequestId = context.selectedServiceRequest.id;
        else if (selectedDate) delete query.serviceRequestId;

        installAssignmentRenderGate(req, res, selectedDate, context, cityScope);
        return next();
      }

      if (req.method === 'POST') {
        const cityScope = await resolveAssignmentCityScope(prisma, req);
        req.operationalCityScope = cityScope;
        if (!await enforceAssignmentEditScope(prisma, req, res, cityScope)) return;
        const allowed = await installAssignmentRedirectDate(prisma, req, res, cityScope);
        if (!allowed) return;
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
