import {
  buildDispatchServiceDateWhere,
  dispatchServiceDateKey,
  filterDispatchServiceRequestsByDate,
  normalizeDispatchDateParam
} from '../services/dispatchDate.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const ASSIGNMENT_VIEW = 'operacionesAsignacionesConfirmacion';
const ASSIGNMENT_PATH = '/admin/operaciones/asignaciones';
const DATE_NAVIGATION_SCRIPT_ID = 'dispatch-assignment-date-navigation-guard';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function showsAllDates(query = {}) {
  return query.allDates === '1' || query.allDates === 'true';
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

export async function loadAssignmentDateContext(prisma, selectedDate, requestedServiceRequestId = null) {
  if (!selectedDate) return null;
  const serviceRequestsRaw = await prisma.dispatchServiceRequest.findMany({
    where: buildDispatchServiceDateWhere(selectedDate),
    include: {
      service: true,
      assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } }
    },
    orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }]
  });
  const serviceRequests = filterDispatchServiceRequestsByDate(serviceRequestsRaw, selectedDate);

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
        select: { workerId: true, serviceRequest: { select: { serviceDate: true } } }
      })
    : [];
  const sameDayAssignments = sameDayAssignmentsRaw.filter(
    (assignment) => dispatchServiceDateKey(assignment.serviceRequest?.serviceDate) === selectedDate
  );

  return {
    selectedDate,
    serviceRequests,
    selectedServiceRequest,
    blockedWorkerIds,
    assignedWorkerIdsOnSelectedDate: new Set(sameDayAssignments.map((assignment) => assignment.workerId))
  };
}

export function buildAssignmentDateNavigationScript() {
  return `<script id="${DATE_NAVIGATION_SCRIPT_ID}">
(() => {
  function navigateToDate(value, allDates) {
    const url = new URL(window.location.href);
    url.searchParams.delete('serviceRequestId');
    url.searchParams.delete('message');
    url.searchParams.delete('date');
    if (allDates) {
      url.searchParams.delete('fecha');
      url.searchParams.set('allDates', '1');
    } else if (value) {
      url.searchParams.set('fecha', value);
      url.searchParams.delete('allDates');
    }
    window.location.assign(url.toString());
  }

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== 'assignmentDateFilter') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigateToDate(input.value, false);
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('#clearAssignmentDateFilter') : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigateToDate('', true);
  }, true);
})();
</script>`;
}

function injectDateNavigationScript(html) {
  if (typeof html !== 'string' || html.includes(DATE_NAVIGATION_SCRIPT_ID)) return html;
  return html.replace(/<\/body>/i, `${buildAssignmentDateNavigationScript()}\n</body>`);
}

function installAssignmentRenderGate(req, res, next, context) {
  const originalRender = res.render.bind(res);
  res.render = (view, locals, callback) => {
    let renderLocals = locals || {};
    let renderCallback = callback;
    if (typeof locals === 'function') {
      renderCallback = locals;
      renderLocals = {};
    }

    if (view !== ASSIGNMENT_VIEW) return originalRender(view, renderLocals, renderCallback);

    const nextLocals = { ...renderLocals };
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

    return originalRender(view, nextLocals, (error, html) => {
      if (error) {
        if (typeof renderCallback === 'function') return renderCallback(error);
        return next(error);
      }
      const output = injectDateNavigationScript(html);
      if (typeof renderCallback === 'function') return renderCallback(null, output);
      return res.send(output);
    });
  };
}

async function installAssignmentRedirectDate(prisma, req, res) {
  const serviceRequestId = normalizeString(req.body?.serviceRequestId);
  if (!serviceRequestId) return;
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { serviceDate: true }
  });
  const dateKey = dispatchServiceDateKey(serviceRequest?.serviceDate);
  if (!dateKey) return;

  const originalRedirect = res.redirect.bind(res);
  res.redirect = (statusOrUrl, maybeUrl) => {
    if (typeof statusOrUrl === 'number') {
      return originalRedirect(statusOrUrl, addDateToAssignmentRedirect(maybeUrl, dateKey));
    }
    return originalRedirect(addDateToAssignmentRedirect(statusOrUrl, dateKey));
  };
}

export function dispatchAssignmentDateGuard(prisma) {
  return async function assignmentDateGuard(req, res, next) {
    try {
      if (req.method === 'GET') {
        const selectedDate = assignmentDateFromQuery(req.query || {});
        const requestedServiceRequestId = normalizeString(req.query?.serviceRequestId);
        const context = selectedDate
          ? await loadAssignmentDateContext(prisma, selectedDate, requestedServiceRequestId)
          : null;

        if (context?.selectedServiceRequest) req.query.serviceRequestId = context.selectedServiceRequest.id;
        else if (selectedDate) delete req.query.serviceRequestId;

        installAssignmentRenderGate(req, res, next, context);
        return next();
      }

      if (req.method === 'POST') await installAssignmentRedirectDate(prisma, req, res);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
