import {
  calculateAttendanceDistanceMeters,
  isAttendanceInsideGeofence
} from '../domain/attendanceDistance.js';

const ACTIVE_ASSIGNMENT_STATUSES = new Set(['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']);
const BREAK_MARK_TYPES = new Set(['BREAK_START', 'BREAK_END']);
const ONLINE_WEB_CAPTURE_MODE = 'ONLINE_WEB';
const OFFLINE_WEB_CAPTURE_MODE = 'OFFLINE_WEB';
const MAX_OFFLINE_CAPTURE_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_CLIENT_CLOCK_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_SERIALIZABLE_RETRIES = 3;

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_required`);
  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label}_invalid`);
  return value.trim() || null;
}

function dateValue(value, label, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label}_required`);
    return null;
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function numberValue(value, label, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}_invalid`);
  return number;
}

function finitePointNumber(value) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCaptureMode(value) {
  const normalized = value === undefined || value === null || value === ''
    ? ONLINE_WEB_CAPTURE_MODE
    : requireString(value, 'attendance_capture_mode').toUpperCase();
  if (![ONLINE_WEB_CAPTURE_MODE, OFFLINE_WEB_CAPTURE_MODE].includes(normalized)) {
    throw new Error('attendance_capture_mode_invalid');
  }
  return normalized;
}

function markMoment(mark) {
  return dateValue(mark?.clientCapturedAt ?? mark?.serverReceivedAt, 'attendance_break_mark_time', true);
}

function normalizeInput(input = {}) {
  const now = dateValue(input.now ?? new Date(), 'attendance_server_now', true);
  const captureMode = normalizeCaptureMode(input.captureMode);
  const clientCapturedAt = dateValue(input.clientCapturedAt, 'client_captured_at');
  const reportedAt = captureMode === OFFLINE_WEB_CAPTURE_MODE
    ? dateValue(clientCapturedAt, 'client_captured_at', true)
    : now;
  if (captureMode === OFFLINE_WEB_CAPTURE_MODE) {
    if (reportedAt.getTime() - now.getTime() > MAX_CLIENT_CLOCK_FUTURE_SKEW_MS) {
      throw new Error('attendance_offline_capture_future_invalid');
    }
    if (now.getTime() - reportedAt.getTime() > MAX_OFFLINE_CAPTURE_AGE_MS) {
      throw new Error('attendance_offline_capture_expired');
    }
  }
  const markType = requireString(input.markType, 'attendance_break_mark_type').toUpperCase();
  if (!BREAK_MARK_TYPES.has(markType)) throw new Error('attendance_break_mark_type_invalid');
  return {
    assignmentId: requireString(input.assignmentId, 'assignment_id'),
    expectedWorkerId: optionalString(input.expectedWorkerId, 'expected_worker_id'),
    idempotencyKey: requireString(input.idempotencyKey, 'idempotency_key'),
    markType,
    now,
    reportedAt,
    clientCapturedAt,
    captureMode,
    latitude: numberValue(input.latitude, 'latitude', -90, 90),
    longitude: numberValue(input.longitude, 'longitude', -180, 180),
    accuracyMeters: numberValue(input.accuracyMeters, 'accuracy_meters', 0, 100_000),
    installationIdHash: optionalString(input.installationIdHash, 'installation_id_hash'),
    ipAddress: optionalString(input.ipAddress, 'ip_address'),
    userAgent: optionalString(input.userAgent, 'user_agent')
  };
}

function requirePrisma(prisma) {
  if (typeof prisma?.$transaction !== 'function') throw new Error('attendance_break_transaction_required');
  const required = {
    dispatchAssignment: ['findUnique'],
    dispatchAttendanceMark: ['findUnique', 'findMany', 'create'],
    dispatchWorkerDevice: ['findFirst']
  };
  for (const [modelName, methods] of Object.entries(required)) {
    if (!prisma[modelName] || methods.some((method) => typeof prisma[modelName][method] !== 'function')) {
      throw new Error(`attendance_break_${modelName}_contract_invalid`);
    }
  }
}

function requireGeofence(point, input) {
  const latitude = finitePointNumber(point?.attendanceLatitude);
  const longitude = finitePointNumber(point?.attendanceLongitude);
  const radiusMeters = finitePointNumber(point?.geofenceRadiusMeters);
  if (latitude === null || longitude === null || radiusMeters === null || radiusMeters <= 0) {
    throw new Error('attendance_operation_geofence_required');
  }
  if (input.latitude === null || input.longitude === null) {
    throw new Error('attendance_location_required');
  }

  const maxAccuracyMeters = finitePointNumber(point?.maxLocationAccuracyMeters) ?? 100;
  if (input.accuracyMeters === null || input.accuracyMeters > maxAccuracyMeters) {
    throw new Error('attendance_location_accuracy_insufficient');
  }

  const distanceMeters = calculateAttendanceDistanceMeters(
    { latitude, longitude },
    { latitude: input.latitude, longitude: input.longitude }
  );
  if (isAttendanceInsideGeofence(distanceMeters, radiusMeters) !== true) {
    throw new Error('attendance_outside_operation_range');
  }
  return { distanceMeters, insideGeofence: true };
}

function replayResult(mark) {
  return {
    recorded: true,
    replayed: true,
    attendanceSession: mark.attendanceSession,
    attendanceMark: mark,
    validation: {
      validationStatus: mark.decision,
      riskScore: mark.riskScore,
      riskFlags: Array.isArray(mark.riskFlags) ? mark.riskFlags : []
    }
  };
}

async function insideTransaction(client, input) {
  const replay = await client.dispatchAttendanceMark.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { attendanceSession: true }
  });
  if (replay) return replayResult(replay);

  const assignment = await client.dispatchAssignment.findUnique({
    where: { id: input.assignmentId },
    include: {
      attendanceSession: true,
      serviceRequest: { include: { operationPoint: true } }
    }
  });
  if (!assignment || (input.expectedWorkerId && assignment.workerId !== input.expectedWorkerId)) {
    throw new Error('attendance_assignment_not_found');
  }
  if (!ACTIVE_ASSIGNMENT_STATUSES.has(assignment.status)) throw new Error('attendance_assignment_inactive');
  if (assignment.serviceRequest.operationPoint?.attendanceEnabled !== true) throw new Error('attendance_not_enabled');

  const session = assignment.attendanceSession;
  if (!session?.arrivalReportedAt) throw new Error('attendance_break_arrival_required');
  if (session.departureReportedAt) throw new Error('attendance_break_after_departure');
  if (input.reportedAt.getTime() < session.arrivalReportedAt.getTime()) {
    throw new Error('attendance_break_before_arrival');
  }

  const breakMarks = await client.dispatchAttendanceMark.findMany({
    where: {
      attendanceSessionId: session.id,
      markType: { in: ['BREAK_START', 'BREAK_END'] }
    },
    orderBy: { serverReceivedAt: 'asc' }
  });
  const breakStart = breakMarks.find((mark) => mark.markType === 'BREAK_START') || null;
  const breakEnd = breakMarks.find((mark) => mark.markType === 'BREAK_END') || null;

  if (input.markType === 'BREAK_START' && breakStart && !breakEnd) {
    throw new Error('attendance_break_already_started');
  }
  if (input.markType === 'BREAK_START' && breakEnd) {
    throw new Error('attendance_break_already_completed');
  }
  if (input.markType === 'BREAK_END' && !breakStart) {
    throw new Error('attendance_break_start_required');
  }
  if (input.markType === 'BREAK_END' && breakEnd) {
    throw new Error('attendance_break_already_completed');
  }
  if (input.markType === 'BREAK_END' && input.reportedAt.getTime() < markMoment(breakStart).getTime()) {
    throw new Error('attendance_break_end_before_start');
  }

  const point = assignment.serviceRequest.operationPoint;
  const geofence = requireGeofence(point, input);
  const workerDevice = input.installationIdHash
    ? await client.dispatchWorkerDevice.findFirst({
        where: {
          workerId: assignment.workerId,
          installationIdHash: input.installationIdHash,
          status: 'ACTIVE',
          revokedAt: null
        }
      })
    : null;

  const riskFlags = Array.isArray(session.riskFlags) ? session.riskFlags : [];
  const mark = await client.dispatchAttendanceMark.create({
    data: {
      attendanceSessionId: session.id,
      workerDeviceId: workerDevice?.id ?? null,
      markType: input.markType,
      idempotencyKey: input.idempotencyKey,
      serverReceivedAt: input.now,
      clientCapturedAt: input.clientCapturedAt ?? input.reportedAt,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      distanceToPointMeters: geofence.distanceMeters,
      insideGeofence: geofence.insideGeofence,
      installationIdHash: input.installationIdHash,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      decision: session.validationStatus,
      riskScore: Number(session.riskScore) || 0,
      riskFlags
    }
  });

  return {
    recorded: true,
    replayed: false,
    attendanceSession: session,
    attendanceMark: mark,
    validation: {
      validationStatus: session.validationStatus,
      riskScore: Number(session.riskScore) || 0,
      riskFlags
    }
  };
}

export async function registerDispatchBreak(prisma, input = {}) {
  requirePrisma(prisma);
  const normalized = normalizeInput(input);
  let lastError;
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => insideTransaction(tx, normalized),
        { isolationLevel: 'Serializable' }
      );
    } catch (error) {
      lastError = error;
      if (!['P2002', 'P2034'].includes(error?.code) || attempt === MAX_SERIALIZABLE_RETRIES) break;
    }
  }
  if (lastError?.code === 'P2002') {
    const replay = await prisma.dispatchAttendanceMark.findUnique({
      where: { idempotencyKey: normalized.idempotencyKey },
      include: { attendanceSession: true }
    });
    if (replay) return replayResult(replay);
  }
  throw lastError;
}
