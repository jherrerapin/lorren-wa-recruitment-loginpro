import { randomBytes } from 'node:crypto';

export const DEV_TEST_REQUEST_SOURCE = 'DEV_TEST';
export const DEV_TEST_ATTENDANCE_SOURCE = 'DEV_TEST_MANUAL';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATETIME_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const ACTIVE_ASSIGNMENT_STATUSES = ['DEV_TEST_ASSIGNED', 'DEV_TEST_CONFIRMED'];

function normalizeString(value, maxLength = 500) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.max(1, Math.trunc(parsed));
}

function requiredDate(value) {
  const text = normalizeString(value, 10);
  if (!text || !DATE_PATTERN.test(text)) throw new Error('dev_test_service_date_invalid');
  const date = new Date(`${text}T00:00:00-05:00`);
  if (Number.isNaN(date.getTime())) throw new Error('dev_test_service_date_invalid');
  return date;
}

function requiredTime(value, code) {
  const text = normalizeString(value, 5);
  if (!text || !TIME_PATTERN.test(text)) throw new Error(code);
  return text;
}

function optionalTime(value, code) {
  const text = normalizeString(value, 5);
  if (!text) return null;
  if (!TIME_PATTERN.test(text)) throw new Error(code);
  return text;
}

export function buildDevTestTimeBlocks(body = {}) {
  const quantities = asArray(body.requiredWorkers);
  const starts = asArray(body.startTime);
  const ends = asArray(body.endTime);
  const dates = asArray(body.serviceDateBlock ?? body.serviceDate);
  const count = Math.max(quantities.length, starts.length, ends.length, dates.length, 1);
  const blocks = [];
  for (let index = 0; index < count; index += 1) {
    const requiredWorkers = positiveInteger(quantities[index] ?? quantities[0]);
    if (!requiredWorkers) throw new Error('dev_test_required_workers_invalid');
    blocks.push({
      serviceDate: requiredDate(dates[index] ?? dates[0]),
      startTime: requiredTime(starts[index] ?? starts[0], 'dev_test_start_time_invalid'),
      endTime: optionalTime(ends[index] ?? null, 'dev_test_end_time_invalid'),
      requiredWorkers
    });
  }
  return blocks;
}

function serviceDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('dev_test_service_date_invalid');
  return new Date(date.getTime() - (5 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function bogotaDateTime(dateKey, time) {
  if (!DATE_PATTERN.test(String(dateKey || '')) || !TIME_PATTERN.test(String(time || ''))) return null;
  const date = new Date(`${dateKey}T${time}:00-05:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLocalDateTime(value, code, required = false) {
  const text = normalizeString(value, 16);
  if (!text) {
    if (required) throw new Error(code);
    return null;
  }
  if (!DATETIME_LOCAL_PATTERN.test(text)) throw new Error(code);
  const date = new Date(`${text}:00-05:00`);
  if (Number.isNaN(date.getTime())) throw new Error(code);
  return date;
}

function requestGroupCode(blockCount) {
  if (blockCount < 2) return null;
  return `TEST-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
}

function testServiceName(service, groupCode) {
  const name = normalizeString(service?.name, 180) || 'Servicio de prueba';
  return groupCode ? `${name} · Grupo ${groupCode}` : name;
}

function actorRole(actor) {
  return normalizeString(actor?.actorRole, 80)?.toLowerCase() || 'admin';
}

export async function createDevTestServiceRequests(prisma, body = {}, actor = {}) {
  const clientId = normalizeString(body.clientId, 120);
  const operationPointId = normalizeString(body.operationPointId, 120);
  const serviceId = normalizeString(body.serviceId, 120);
  if (!clientId || !operationPointId) throw new Error('dev_test_client_operation_required');

  const blocks = buildDevTestTimeBlocks(body);
  const client = await prisma.dispatchClient.findFirst({
    where: { id: clientId, isActive: true },
    include: {
      operationPoints: { where: { isActive: true } },
      services: { where: { isActive: true } }
    }
  });
  if (!client) throw new Error('dev_test_client_not_found');
  const operationPoint = client.operationPoints.find((item) => item.id === operationPointId);
  if (!operationPoint) throw new Error('dev_test_operation_not_found');
  const service = serviceId ? client.services.find((item) => item.id === serviceId) || null : null;
  if (client.services.length && !service) throw new Error('dev_test_service_not_found');

  const groupCode = requestGroupCode(blocks.length);
  const baseData = {
    operationPointId: operationPoint.id,
    clientName: client.name,
    operationPointName: operationPoint.name,
    cityName: operationPoint.cityName || client.cityName,
    address: operationPoint.address || normalizeString(body.address),
    serviceId: service?.id || null,
    serviceName: testServiceName(service, groupCode),
    notes: normalizeString(body.notes),
    status: 'DEV_TEST_PENDING',
    source: DEV_TEST_REQUEST_SOURCE,
    createdByUsername: normalizeString(actor.actorUsername, 160) || 'TEST-WORKSPACE'
  };
  const created = await prisma.$transaction(blocks.map((block) => prisma.dispatchServiceRequest.create({
    data: { ...baseData, ...block }
  })));

  await prisma.devAuditEvent.create({
    data: {
      entityType: 'DISPATCH_DEV_TEST_REQUEST',
      entityId: created[0]?.id || null,
      entityLabel: `${client.name} · ${operationPoint.name}`,
      action: 'DEV_TEST_REQUEST_CREATED',
      actorUsername: normalizeString(actor.actorUsername, 160),
      actorRole: actorRole(actor),
      actorSource: 'test-workspace',
      metadata: {
        requestIds: created.map((item) => item.id),
        blocks: blocks.length,
        source: DEV_TEST_REQUEST_SOURCE,
        realEntityReferences: true,
        operationalRecordsChanged: false
      }
    }
  });
  return { created, groupCode, client, operationPoint };
}

export async function loadDevTestWorkspace(prisma, query = {}) {
  const [requests, clients, workers] = await Promise.all([
    prisma.dispatchServiceRequest.findMany({
      where: { source: DEV_TEST_REQUEST_SOURCE },
      include: {
        service: true,
        operationPoint: { include: { client: true } },
        assignments: {
          include: {
            worker: true,
            attendanceSession: { include: { marks: { orderBy: { serverReceivedAt: 'asc' } } } }
          },
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: [{ serviceDate: 'desc' }, { startTime: 'asc' }, { createdAt: 'desc' }],
      take: 100
    }),
    prisma.dispatchClient.findMany({
      where: { isActive: true },
      include: {
        operationPoints: { where: { isActive: true }, orderBy: { name: 'asc' } },
        services: { where: { isActive: true }, orderBy: { name: 'asc' } }
      },
      orderBy: { name: 'asc' }
    }),
    prisma.dispatchWorker.findMany({
      where: { operationalStatus: { not: 'ELIMINADO' } },
      orderBy: { fullName: 'asc' }
    })
  ]);
  const selectedId = normalizeString(query.serviceRequestId, 120) || requests[0]?.id || null;
  const selectedRequest = requests.find((item) => item.id === selectedId) || null;
  const assignedIds = new Set((selectedRequest?.assignments || [])
    .filter((assignment) => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status))
    .map((assignment) => assignment.workerId));
  return {
    requests,
    clients,
    selectedRequest,
    workers,
    testWorkers: workers,
    availableWorkers: workers.filter((worker) => !assignedIds.has(worker.id))
  };
}

export async function assignDevTestWorker(prisma, input = {}, actor = {}) {
  const serviceRequestId = normalizeString(input.serviceRequestId, 120);
  const workerId = normalizeString(input.workerId, 120);
  if (!serviceRequestId || !workerId) throw new Error('dev_test_assignment_required');
  const [request, worker] = await Promise.all([
    prisma.dispatchServiceRequest.findUnique({ where: { id: serviceRequestId } }),
    prisma.dispatchWorker.findUnique({ where: { id: workerId } })
  ]);
  if (!request || request.source !== DEV_TEST_REQUEST_SOURCE) throw new Error('dev_test_request_not_found');
  if (!worker || worker.operationalStatus === 'ELIMINADO') throw new Error('dev_test_worker_required');

  const username = normalizeString(actor.actorUsername, 160) || 'TEST-WORKSPACE';
  const assignment = await prisma.dispatchAssignment.upsert({
    where: { serviceRequestId_workerId: { serviceRequestId, workerId } },
    update: { status: 'DEV_TEST_ASSIGNED', notes: 'Asignación aislada del entorno de pruebas.', createdByUsername: username },
    create: { serviceRequestId, workerId, status: 'DEV_TEST_ASSIGNED', notes: 'Asignación aislada del entorno de pruebas.', createdByUsername: username }
  });
  const assignedCount = await prisma.dispatchAssignment.count({
    where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } }
  });
  await prisma.dispatchServiceRequest.update({
    where: { id: serviceRequestId },
    data: { status: assignedCount >= request.requiredWorkers ? 'DEV_TEST_COMPLETE' : 'DEV_TEST_PARTIAL' }
  });
  return assignment;
}

function validateChronology({ arrivalAt, breakStartAt, breakEndAt, departureAt }) {
  if (departureAt <= arrivalAt) throw new Error('dev_test_departure_before_arrival');
  if (breakEndAt && !breakStartAt) throw new Error('dev_test_break_start_required');
  if (breakStartAt && (breakStartAt < arrivalAt || breakStartAt > departureAt)) throw new Error('dev_test_break_start_outside_shift');
  if (breakEndAt && (breakEndAt <= breakStartAt || breakEndAt > departureAt)) throw new Error('dev_test_break_end_invalid');
}

function markData(sessionId, assignmentId, markType, moment, actor) {
  return {
    attendanceSessionId: sessionId,
    markType,
    idempotencyKey: `${DEV_TEST_ATTENDANCE_SOURCE}:${assignmentId}:${markType}:${moment.getTime()}`,
    serverReceivedAt: moment,
    clientCapturedAt: moment,
    decision: 'MANUAL_VALIDATED',
    riskScore: 0,
    riskFlags: ['DEV_TEST_MANUAL'],
    userAgent: `TEST-WORKSPACE:${normalizeString(actor.actorUsername, 120) || 'unknown'}`
  };
}

export async function saveDevTestAttendance(prisma, input = {}, actor = {}) {
  const assignmentId = normalizeString(input.assignmentId, 120);
  if (!assignmentId) throw new Error('dev_test_assignment_required');
  const arrivalAt = parseLocalDateTime(input.arrivalAt, 'dev_test_arrival_invalid', true);
  const departureAt = parseLocalDateTime(input.departureAt, 'dev_test_departure_invalid', true);
  const breakStartAt = parseLocalDateTime(input.breakStartAt, 'dev_test_break_start_invalid');
  const breakEndAt = parseLocalDateTime(input.breakEndAt, 'dev_test_break_end_invalid');
  validateChronology({ arrivalAt, breakStartAt, breakEndAt, departureAt });

  const assignment = await prisma.dispatchAssignment.findUnique({
    where: { id: assignmentId },
    include: { worker: true, serviceRequest: { include: { operationPoint: { include: { client: true } } } } }
  });
  if (!assignment || assignment.serviceRequest?.source !== DEV_TEST_REQUEST_SOURCE) throw new Error('dev_test_assignment_not_found');
  if (!assignment.worker || assignment.worker.operationalStatus === 'ELIMINADO') throw new Error('dev_test_worker_required');

  const dateKey = serviceDateKey(assignment.serviceRequest.serviceDate);
  const expectedStartAt = bogotaDateTime(dateKey, assignment.serviceRequest.startTime) || arrivalAt;
  let expectedEndAt = bogotaDateTime(dateKey, assignment.serviceRequest.endTime);
  if (expectedEndAt && expectedEndAt <= expectedStartAt) expectedEndAt = new Date(expectedEndAt.getTime() + (24 * 60 * 60 * 1000));
  const now = new Date();
  const punctualityStatus = arrivalAt <= expectedStartAt ? 'ON_TIME' : 'LATE';

  const session = await prisma.$transaction(async (tx) => {
    const savedSession = await tx.dispatchAttendanceSession.upsert({
      where: { assignmentId },
      update: {
        expectedStartAt, expectedEndAt, attendanceStatus: 'COMPLETED', validationStatus: 'MANUAL_VALIDATED',
        punctualityStatus, riskScore: 0, riskFlags: ['DEV_TEST_MANUAL'], arrivalReportedAt: arrivalAt,
        arrivalValidatedAt: now, departureReportedAt: departureAt, departureValidatedAt: now,
        workedMinutes: null, source: DEV_TEST_ATTENDANCE_SOURCE
      },
      create: {
        assignmentId, expectedStartAt, expectedEndAt, attendanceStatus: 'COMPLETED', validationStatus: 'MANUAL_VALIDATED',
        punctualityStatus, riskScore: 0, riskFlags: ['DEV_TEST_MANUAL'], arrivalReportedAt: arrivalAt,
        arrivalValidatedAt: now, departureReportedAt: departureAt, departureValidatedAt: now,
        workedMinutes: null, source: DEV_TEST_ATTENDANCE_SOURCE
      }
    });
    await tx.dispatchAttendanceMark.deleteMany({ where: { attendanceSessionId: savedSession.id } });
    const marks = [
      markData(savedSession.id, assignmentId, 'ARRIVAL', arrivalAt, actor),
      ...(breakStartAt ? [markData(savedSession.id, assignmentId, 'BREAK_START', breakStartAt, actor)] : []),
      ...(breakEndAt ? [markData(savedSession.id, assignmentId, 'BREAK_END', breakEndAt, actor)] : []),
      markData(savedSession.id, assignmentId, 'DEPARTURE', departureAt, actor)
    ];
    await tx.dispatchAttendanceMark.createMany({ data: marks });
    await tx.dispatchAttendanceReview.create({
      data: {
        attendanceSessionId: savedSession.id,
        action: 'DEV_TEST_MANUAL_TIMES',
        previousAttendanceStatus: null,
        newAttendanceStatus: 'COMPLETED',
        previousValidationStatus: null,
        newValidationStatus: 'MANUAL_VALIDATED',
        reason: 'Jornada manual aislada para validar cálculos de nómina.',
        notes: normalizeString(input.notes),
        actorUsername: normalizeString(actor.actorUsername, 160) || 'TEST-WORKSPACE',
        actorRole: actorRole(actor),
        metadata: { source: DEV_TEST_ATTENDANCE_SOURCE, arrivalAt, breakStartAt, breakEndAt, departureAt, operationalRecordsChanged: false }
      }
    });
    return savedSession;
  });
  return { session, assignment, arrivalAt, breakStartAt, breakEndAt, departureAt };
}

export function formatBogotaDateTimeLocal(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - (5 * 60 * 60 * 1000)).toISOString().slice(0, 16);
}

export function defaultDevTestTimes(request) {
  const dateKey = serviceDateKey(request.serviceDate);
  const arrival = bogotaDateTime(dateKey, request.startTime || '08:00') || new Date(request.serviceDate);
  let departure = bogotaDateTime(dateKey, request.endTime || '16:00') || new Date(arrival.getTime() + (8 * 60 * 60 * 1000));
  if (departure <= arrival) departure = new Date(departure.getTime() + (24 * 60 * 60 * 1000));
  return {
    arrivalAt: formatBogotaDateTimeLocal(arrival),
    breakStartAt: '',
    breakEndAt: '',
    departureAt: formatBogotaDateTimeLocal(departure)
  };
}
