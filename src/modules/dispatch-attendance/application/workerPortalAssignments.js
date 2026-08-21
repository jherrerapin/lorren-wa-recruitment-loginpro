import {
  ACTIVE_DISPATCH_ASSIGNMENT_STATUSES,
  getDispatchArrivalWindowState,
  isDispatchBreakEndWithinOperationalWindow,
  isDispatchBreakStartWithinOperationalWindow,
  isDispatchDepartureWithinOperationalWindow,
  resolveDispatchAttendanceOperationalWindow
} from './registerArrival.js';
import { loadCrewAttendancePortalContexts } from './crewAttendanceConfig.js';
import {
  INCOMPLETE_DISPATCH_BREAK_PENALTY_MINUTES,
  STANDARD_DISPATCH_BREAK_MINUTES,
  STANDARD_DISPATCH_WORKDAY_MINUTES,
  formatDispatchMinutes
} from '../domain/attendanceWorkdayPolicy.js';
import { dispatchServiceDateKey } from '../../../services/dispatchDate.js';

const BOGOTA_TIME_ZONE = 'America/Bogota';

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_required`);
  return value.trim();
}

function requireDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function optionalIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requireAssignmentReader(prisma, methodName) {
  if (!prisma?.dispatchAssignment || typeof prisma.dispatchAssignment[methodName] !== 'function') {
    throw new Error(`worker_portal_assignment_${methodName}_required`);
  }
}

function requireWorkerReader(prisma) {
  if (!prisma?.dispatchWorker || typeof prisma.dispatchWorker.findUnique !== 'function') {
    throw new Error('worker_portal_worker_findUnique_required');
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(value);
}

function formatServiceDate(value) {
  const dateKey = dispatchServiceDateKey(value);
  if (!dateKey) throw new Error('worker_portal_assignment_service_date_invalid');
  return formatDate(new Date(`${dateKey}T12:00:00.000Z`));
}

function formatTime(value) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(value);
}

function formatDateTime(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(requireDate(value, 'worker_portal_datetime'));
}

function arrivalLabel(session) {
  if (!session?.arrivalReportedAt) return null;
  if (session.validationStatus === 'AUTO_VALIDATED') {
    return session.punctualityStatus === 'LATE'
      ? 'Llegada validada · tarde'
      : 'Llegada validada · a tiempo';
  }
  if (session.validationStatus === 'REVIEW_REQUIRED') return 'Llegada registrada · en revisión';
  if (session.validationStatus === 'REJECTED') return 'Llegada rechazada';
  return 'Llegada registrada';
}

function normalizePhotoPolicy(value) {
  return ['NEVER', 'RISK_ONLY', 'ALWAYS'].includes(value) ? value : 'RISK_ONLY';
}

function markMoment(mark) {
  const raw = mark?.clientCapturedAt || mark?.serverReceivedAt;
  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latestMark(marks, markType) {
  return (Array.isArray(marks) ? marks : [])
    .filter((mark) => mark.markType === markType)
    .sort((left, right) => (markMoment(right)?.getTime() || 0) - (markMoment(left)?.getTime() || 0))[0] || null;
}

function minutesBetween(startAt, endAt) {
  if (!startAt || !endAt) return null;
  return Math.max(0, Math.floor((endAt.getTime() - startAt.getTime()) / 60_000));
}

function buildBreakSummary({ breakStartAt, breakEndAt, departureReported }) {
  if (!breakStartAt) {
    return {
      breakMinutesDeducted: 0,
      breakPenaltyApplied: false,
      shortBreakMinutesCredited: departureReported ? STANDARD_DISPATCH_BREAK_MINUTES : 0,
      breakLabel: departureReported
        ? 'No tomó almuerzo · el tiempo cuenta como trabajado'
        : 'No registrado · si no toma almuerzo, ese tiempo cuenta como trabajado'
    };
  }

  if (!breakEndAt) {
    return {
      breakMinutesDeducted: departureReported ? INCOMPLETE_DISPATCH_BREAK_PENALTY_MINUTES : 0,
      breakPenaltyApplied: departureReported,
      shortBreakMinutesCredited: 0,
      breakLabel: departureReported
        ? 'Se tomó 1 h 30 min de almuerzo · penalización por no marcar regreso'
        : `Inició ${formatDateTime(breakStartAt)} · si registra salida sin finalizar se descontarán 1 h 30 min`
    };
  }

  const actualBreakMinutes = minutesBetween(breakStartAt, breakEndAt) || 0;
  const shortBreakMinutesCredited = Math.max(0, STANDARD_DISPATCH_BREAK_MINUTES - actualBreakMinutes);
  return {
    breakMinutesDeducted: actualBreakMinutes,
    breakPenaltyApplied: false,
    shortBreakMinutesCredited,
    breakLabel: `${formatDateTime(breakStartAt)} – ${formatDateTime(breakEndAt)} · ${formatDispatchMinutes(actualBreakMinutes)}`
  };
}

function isCrewMarkDelegatedToLeader(context) {
  return Boolean(
    context?.mode === 'CREW'
    && context?.crewAvailable === true
    && context?.isCrewLeader !== true
  );
}

async function loadCrewContextsForWorker(prisma, workerId, injectedLoader) {
  if (typeof injectedLoader === 'function') {
    const contexts = await injectedLoader(prisma, { workerId });
    return Array.isArray(contexts) ? contexts : [];
  }
  // Los dobles de prueba históricos del Portal no modelan DevAuditEvent. En runtime Prisma sí lo expone;
  // cuando existe, la única autoridad de modalidad/encargado sigue siendo loadCrewAttendancePortalContexts.
  if (!prisma?.devAuditEvent || typeof prisma.devAuditEvent.findMany !== 'function') return [];
  const contexts = await loadCrewAttendancePortalContexts(prisma, { workerId });
  return Array.isArray(contexts) ? contexts : [];
}

function buildPortalAssignment(assignment, now, crewContext = null) {
  const request = assignment?.serviceRequest;
  if (!request) throw new Error('worker_portal_assignment_service_request_required');

  const point = request.operationPoint ?? null;
  const session = assignment.attendanceSession ?? null;
  const marks = session?.marks || [];
  const breakStartAt = markMoment(latestMark(marks, 'BREAK_START'));
  const breakEndAt = markMoment(latestMark(marks, 'BREAK_END'));
  const breakStarted = Boolean(breakStartAt);
  const breakEnded = Boolean(breakEndAt);
  const breakPending = breakStarted && !breakEnded;

  let operationalWindow = null;
  let expectedStartAt = null;
  let expectedEndAt = null;
  let arrivalWindow = { open: false, opensAt: null, closesAt: null, expired: false };
  if (request.startTime || session?.expectedStartAt) {
    operationalWindow = resolveDispatchAttendanceOperationalWindow(request, session);
    expectedStartAt = operationalWindow.expectedStartAt;
    expectedEndAt = operationalWindow.expectedEndAt;
    arrivalWindow = getDispatchArrivalWindowState({ now, expectedStartAt });
  }

  const arrivalReported = Boolean(session?.arrivalReportedAt);
  const departureReported = Boolean(session?.departureReportedAt);
  const attendanceEnabled = point?.attendanceEnabled === true;
  const sessionRejected = session?.validationStatus === 'REJECTED';
  const crewAvailable = crewContext?.mode === 'CREW' && crewContext?.crewAvailable === true;
  const isCrewLeader = Boolean(crewAvailable && crewContext?.isCrewLeader === true);
  const markDelegatedToCrewLeader = isCrewMarkDelegatedToLeader(crewContext);
  const arrivalDelegatedToCrewLeader = markDelegatedToCrewLeader;
  const canRegisterArrival = attendanceEnabled
    && arrivalWindow.open
    && !arrivalReported
    && !markDelegatedToCrewLeader;
  const canStartBreak = attendanceEnabled
    && arrivalReported
    && !departureReported
    && !breakStarted
    && !sessionRejected
    && !markDelegatedToCrewLeader
    && Boolean(operationalWindow && isDispatchBreakStartWithinOperationalWindow(operationalWindow, now));
  const canEndBreak = attendanceEnabled
    && arrivalReported
    && !departureReported
    && breakPending
    && !sessionRejected
    && !markDelegatedToCrewLeader
    && Boolean(operationalWindow && isDispatchBreakEndWithinOperationalWindow(operationalWindow, now));
  const canRegisterDeparture = attendanceEnabled
    && arrivalReported
    && !departureReported
    && !sessionRejected
    && !markDelegatedToCrewLeader
    && Boolean(operationalWindow && isDispatchDepartureWithinOperationalWindow(operationalWindow, now));
  const photoPolicy = normalizePhotoPolicy(point?.attendancePhotoPolicy);
  const breakSummary = buildBreakSummary({ breakStartAt, breakEndAt, departureReported });
  const workedMinutes = Number.isInteger(session?.workedMinutes) ? session.workedMinutes : null;
  const ordinaryWorkedMinutes = workedMinutes === null
    ? null
    : Math.min(workedMinutes, STANDARD_DISPATCH_WORKDAY_MINUTES);
  const overtimeMinutes = workedMinutes === null
    ? null
    : Math.max(0, workedMinutes - STANDARD_DISPATCH_WORKDAY_MINUTES);

  let actionType = 'ARRIVAL';
  let actionLabel = 'Registrar llegada';
  if (departureReported) {
    actionType = 'DONE';
    actionLabel = `Jornada finalizada · ${formatDispatchMinutes(workedMinutes)}`;
  } else if (markDelegatedToCrewLeader) {
    actionType = 'BLOCKED';
    actionLabel = 'Las marcaciones las registra el encargado de cuadrilla';
  } else if (arrivalReported && !canRegisterDeparture) {
    actionType = 'BLOCKED';
    actionLabel = 'Jornada fuera de ventana · requiere coordinación';
  } else if (arrivalReported) {
    actionType = 'DEPARTURE';
    if (isCrewLeader) {
      actionLabel = breakPending
        ? 'Registrar salida de la cuadrilla · se descontarán 1 h 30 min de almuerzo'
        : 'Registrar salida de la cuadrilla';
    } else {
      actionLabel = breakPending
        ? 'Registrar salida · se descontarán 1 h 30 min de almuerzo'
        : 'Registrar salida';
    }
  } else if (!expectedStartAt) actionLabel = 'Horario pendiente';
  else if (!attendanceEnabled) actionLabel = 'Marcación no habilitada';
  else if (!arrivalWindow.open) {
    actionLabel = arrivalWindow.expired ? 'Jornada vencida' : 'Disponible el día de la asignación';
  }

  let breakActionType = null;
  let breakActionLabel = null;
  if (canStartBreak) {
    breakActionType = 'BREAK_START';
    breakActionLabel = isCrewLeader ? 'Iniciar almuerzo de la cuadrilla' : 'Iniciar almuerzo';
  } else if (canEndBreak) {
    breakActionType = 'BREAK_END';
    breakActionLabel = isCrewLeader ? 'Finalizar almuerzo de la cuadrilla' : 'Finalizar almuerzo';
  }

  return {
    id: assignment.id,
    clientName: request.clientName || 'Cliente por confirmar',
    operationPointName: request.operationPointName || point?.name || 'Operación por confirmar',
    cityName: request.cityName || point?.cityName || 'Ciudad por confirmar',
    address: request.address || point?.address || 'Dirección por confirmar',
    dateLabel: formatServiceDate(request.serviceDate),
    timeLabel: expectedStartAt
      ? `${formatTime(expectedStartAt)}${expectedEndAt ? ` – ${formatTime(expectedEndAt)}` : ''}`
      : 'Horario por confirmar',
    expectedStartAt: expectedStartAt?.toISOString() || null,
    expectedEndAt: expectedEndAt?.toISOString() || null,
    operationalEndAt: optionalIsoDate(operationalWindow?.operationalEndAt),
    continuityClosesAt: optionalIsoDate(operationalWindow?.continuityClosesAt),
    operationalWindowDerived: operationalWindow?.derivedOperationalEnd === true,
    arrivalWindowOpen: arrivalWindow.open,
    arrivalWindowOpensAt: optionalIsoDate(arrivalWindow.opensAt),
    arrivalWindowClosesAt: optionalIsoDate(arrivalWindow.closesAt),
    arrivalWindowExpired: arrivalWindow.expired,
    attendanceEnabled,
    crewAvailable,
    isCrewLeader,
    markDelegatedToCrewLeader,
    arrivalReported,
    arrivalReportedAt: optionalIsoDate(session?.arrivalReportedAt),
    arrivalReportedLabel: formatDateTime(session?.arrivalReportedAt),
    arrivalDelegatedToCrewLeader,
    departureReported,
    departureReportedAt: optionalIsoDate(session?.departureReportedAt),
    departureReportedLabel: formatDateTime(session?.departureReportedAt),
    breakStarted,
    breakEnded,
    breakOpen: false,
    breakPending,
    breakStartLabel: formatDateTime(breakStartAt),
    breakEndLabel: formatDateTime(breakEndAt),
    ...breakSummary,
    workedMinutes,
    workedLabel: workedMinutes === null ? null : formatDispatchMinutes(workedMinutes),
    ordinaryWorkedMinutes,
    ordinaryWorkedLabel: ordinaryWorkedMinutes === null ? null : formatDispatchMinutes(ordinaryWorkedMinutes),
    overtimeMinutes,
    overtimeLabel: overtimeMinutes === null ? null : formatDispatchMinutes(overtimeMinutes),
    attendanceStatus: session?.attendanceStatus || 'PENDING',
    validationStatus: session?.validationStatus || 'PENDING',
    punctualityStatus: session?.punctualityStatus || null,
    arrivalStatusLabel: arrivalLabel(session),
    actionType,
    actionLabel,
    breakActionType,
    breakActionLabel,
    canRegisterArrival,
    canStartBreak,
    canEndBreak,
    canRegisterDeparture,
    photoPolicy,
    photoRequired: photoPolicy === 'ALWAYS'
  };
}

function assignmentInclude() {
  return {
    attendanceSession: {
      include: {
        marks: {
          where: { markType: { in: ['BREAK_START', 'BREAK_END'] } },
          orderBy: { serverReceivedAt: 'asc' }
        }
      }
    },
    serviceRequest: { include: { operationPoint: true } }
  };
}

export async function loadWorkerPortalAssignments(prisma, input = {}) {
  requireAssignmentReader(prisma, 'findMany');
  requireWorkerReader(prisma);
  const workerId = requireNonEmptyString(input.workerId, 'worker_portal_worker_id');
  const now = input.now === undefined ? new Date() : requireDate(input.now, 'worker_portal_now');
  const [records, worker, crewContexts] = await Promise.all([
    prisma.dispatchAssignment.findMany({
      where: {
        workerId,
        status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
      },
      include: assignmentInclude()
    }),
    prisma.dispatchWorker.findUnique({
      where: { id: workerId },
      select: { fullName: true, documentNumber: true }
    }),
    loadCrewContextsForWorker(prisma, workerId, input.loadCrewContextsFn)
  ]);

  if (!worker) throw new Error('worker_portal_worker_not_found');
  const crewContextByAssignment = new Map(
    crewContexts
      .filter((context) => context?.assignmentId)
      .map((context) => [context.assignmentId, context])
  );
  const assignments = records
    .map((record) => buildPortalAssignment(record, now, crewContextByAssignment.get(record.id) || null))
    .sort((left, right) => {
      const leftTime = left.expectedStartAt ? new Date(left.expectedStartAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.expectedStartAt ? new Date(right.expectedStartAt).getTime() : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    });

  Object.defineProperty(assignments, 'workerIdentity', {
    value: Object.freeze({
      fullName: requireNonEmptyString(worker.fullName, 'worker_portal_worker_name'),
      documentNumber: worker.documentNumber ? String(worker.documentNumber).trim() : null
    }),
    enumerable: false,
    configurable: false,
    writable: false
  });
  return assignments;
}

export async function loadWorkerPortalAssignmentForMark(prisma, input = {}) {
  requireAssignmentReader(prisma, 'findFirst');
  const workerId = requireNonEmptyString(input.workerId, 'worker_portal_worker_id');
  const assignmentId = requireNonEmptyString(input.assignmentId, 'worker_portal_assignment_id');
  const now = input.now === undefined ? new Date() : requireDate(input.now, 'worker_portal_now');
  const [assignment, crewContexts] = await Promise.all([
    prisma.dispatchAssignment.findFirst({
      where: {
        id: assignmentId,
        workerId,
        status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
      },
      include: assignmentInclude()
    }),
    loadCrewContextsForWorker(prisma, workerId, input.loadCrewContextsFn)
  ]);
  if (!assignment) return null;
  const crewContext = crewContexts.find((context) => context?.assignmentId === assignment.id) || null;
  if (isCrewMarkDelegatedToLeader(crewContext)) return null;
  return buildPortalAssignment(assignment, now, crewContext);
}

export async function loadWorkerPortalAssignmentForArrival(prisma, input = {}) {
  return loadWorkerPortalAssignmentForMark(prisma, input);
}