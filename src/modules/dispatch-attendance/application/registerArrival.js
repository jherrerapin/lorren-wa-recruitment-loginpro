import {
  ATTENDANCE_RISK_FLAG,
  ATTENDANCE_VALIDATION_STATUS,
  evaluateArrivalValidation
} from '../domain/attendanceValidationPolicy.js';
import {
  calculateAttendanceDistanceMeters,
  isAttendanceInsideGeofence
} from '../domain/attendanceDistance.js';

export const ACTIVE_DISPATCH_ASSIGNMENT_STATUSES = Object.freeze([
  'ASSIGNED',
  'CONFIRMATION_PENDING',
  'CONFIRMED'
]);

const ACTIVE_ASSIGNMENT_STATUS_SET = new Set(ACTIVE_DISPATCH_ASSIGNMENT_STATUSES);
const MAX_SERIALIZABLE_RETRIES = 3;
const SERIALIZABLE_ISOLATION_LEVEL = 'Serializable';
const BOGOTA_TIME_ZONE = 'America/Bogota';

function requireInputObject(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label}_invalid`);
  }
  return input;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_required`);
  return value.trim();
}

function optionalString(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label}_invalid`);
  return value.trim() || null;
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') throw new Error(`${label}_invalid`);
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function requiredTimestamp(value, label) {
  const date = optionalTimestamp(value, label);
  if (!date) throw new Error(`${label}_required`);
  return date;
}

function optionalFiniteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label}_invalid`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label}_invalid`);
  }
  return number;
}

function requirePrismaContract(client) {
  const required = {
    dispatchAssignment: ['findUnique'],
    dispatchAttendanceSession: ['create', 'update'],
    dispatchAttendanceMark: ['findUnique', 'create'],
    dispatchWorkerDevice: ['findFirst', 'count']
  };

  if (typeof client?.$transaction !== 'function') {
    throw new Error('attendance_arrival_prisma_transaction_required');
  }

  for (const [modelName, methods] of Object.entries(required)) {
    const model = client?.[modelName];
    if (!model || methods.some((method) => typeof model[method] !== 'function')) {
      throw new Error(`attendance_arrival_${modelName}_contract_invalid`);
    }
  }

  return client;
}

function finiteDatabaseNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateKeyInBogota(value) {
  const date = requiredTimestamp(value, 'service_date');
  const isLegacyUtcDateOnly = date.getUTCHours() === 0
    && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0;
  if (isLegacyUtcDateOnly) return date.toISOString().slice(0, 10);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOGOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function parseOperationalTime(value, label) {
  const text = requireNonEmptyString(value, label).toUpperCase();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!match) throw new Error(`${label}_invalid`);

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const period = match[4] || null;

  if (minute > 59 || second > 59) throw new Error(`${label}_invalid`);
  if (period) {
    if (hour < 1 || hour > 12) throw new Error(`${label}_invalid`);
    if (period === 'AM' && hour === 12) hour = 0;
    if (period === 'PM' && hour !== 12) hour += 12;
  } else if (hour > 23) {
    throw new Error(`${label}_invalid`);
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function buildExpectedTimestamp(serviceDate, timeText, label) {
  const dateKey = dateKeyInBogota(serviceDate);
  const time = parseOperationalTime(timeText, label);
  return new Date(`${dateKey}T${time}-05:00`);
}

function buildExpectedWindow(serviceRequest) {
  const expectedStartAt = buildExpectedTimestamp(
    serviceRequest?.serviceDate,
    serviceRequest?.startTime,
    'service_start_time'
  );

  if (!serviceRequest?.endTime) {
    return { expectedStartAt, expectedEndAt: null };
  }

  let expectedEndAt = buildExpectedTimestamp(
    serviceRequest.serviceDate,
    serviceRequest.endTime,
    'service_end_time'
  );
  if (expectedEndAt <= expectedStartAt) {
    expectedEndAt = new Date(expectedEndAt.getTime() + 24 * 60 * 60 * 1000);
  }
  return { expectedStartAt, expectedEndAt };
}

function minutesLateAt(now, expectedStartAt) {
  return Math.max(0, Math.floor((now.getTime() - expectedStartAt.getTime()) / 60_000));
}

function isRetryableWriteConflict(error) {
  return error?.code === 'P2034' || error?.code === 'P2002';
}

async function findIdempotentReplay(client, idempotencyKey) {
  return client.dispatchAttendanceMark.findUnique({
    where: { idempotencyKey },
    include: { attendanceSession: true }
  });
}

function replayResult(mark) {
  return {
    recorded: true,
    replayed: true,
    attendanceSession: mark.attendanceSession,
    attendanceMark: mark,
    validation: {
      attendanceStatus: mark.attendanceSession?.attendanceStatus ?? null,
      validationStatus: mark.attendanceSession?.validationStatus ?? mark.decision ?? null,
      reportedPunctuality: mark.attendanceSession?.punctualityStatus ?? null,
      riskScore: mark.riskScore ?? mark.attendanceSession?.riskScore ?? 0,
      riskFlags: mark.riskFlags ?? mark.attendanceSession?.riskFlags ?? []
    }
  };
}

async function resolveDeviceSignals(client, { workerId, installationIdHash, now }) {
  if (!installationIdHash) {
    return { authorizedDevice: false, sharedDeviceSignal: false, workerDevice: null };
  }

  const workerDevice = await client.dispatchWorkerDevice.findFirst({
    where: {
      workerId,
      installationIdHash,
      status: 'ACTIVE',
      revokedAt: null,
      authorizedFrom: { lte: now },
      OR: [
        { authorizedUntil: null },
        { authorizedUntil: { gte: now } }
      ]
    }
  });

  const sharedDeviceCount = await client.dispatchWorkerDevice.count({
    where: {
      installationIdHash,
      status: 'ACTIVE',
      workerId: { not: workerId }
    }
  });

  return {
    authorizedDevice: Boolean(workerDevice),
    sharedDeviceSignal: sharedDeviceCount > 0,
    workerDevice
  };
}

function geofenceSignals(operationPoint, input) {
  const pointLatitude = finiteDatabaseNumber(operationPoint?.attendanceLatitude);
  const pointLongitude = finiteDatabaseNumber(operationPoint?.attendanceLongitude);
  const radiusMeters = finiteDatabaseNumber(operationPoint?.geofenceRadiusMeters);
  const hasConfiguredGeofence = pointLatitude !== null
    && pointLongitude !== null
    && radiusMeters !== null
    && radiusMeters > 0;

  const distanceToPointMeters = calculateAttendanceDistanceMeters(
    { latitude: pointLatitude, longitude: pointLongitude },
    { latitude: input.latitude, longitude: input.longitude }
  );
  const withinGeofence = hasConfiguredGeofence
    ? isAttendanceInsideGeofence(distanceToPointMeters, radiusMeters)
    : null;

  return { hasConfiguredGeofence, distanceToPointMeters, withinGeofence };
}

async function registerInsideTransaction(client, input) {
  const replay = await findIdempotentReplay(client, input.idempotencyKey);
  if (replay) return replayResult(replay);

  const assignment = await client.dispatchAssignment.findUnique({
    where: { id: input.assignmentId },
    include: {
      attendanceSession: true,
      serviceRequest: { include: { operationPoint: true } }
    }
  });
  if (!assignment) throw new Error('attendance_assignment_not_found');

  const operationPoint = assignment.serviceRequest?.operationPoint ?? null;
  const existingSession = assignment.attendanceSession ?? null;
  const assignmentActive = ACTIVE_ASSIGNMENT_STATUS_SET.has(assignment.status);
  const attendanceEnabled = operationPoint?.attendanceEnabled === true;
  const duplicateMark = Boolean(existingSession?.arrivalReportedAt);

  if (!assignmentActive || !attendanceEnabled || duplicateMark) {
    const validation = evaluateArrivalValidation({
      assignmentActive,
      attendanceEnabled,
      duplicateMark
    });
    return {
      recorded: false,
      replayed: false,
      attendanceSession: existingSession,
      attendanceMark: null,
      validation
    };
  }

  const expectedWindow = existingSession
    ? {
        expectedStartAt: requiredTimestamp(existingSession.expectedStartAt, 'expected_start_at'),
        expectedEndAt: optionalTimestamp(existingSession.expectedEndAt, 'expected_end_at')
      }
    : buildExpectedWindow(assignment.serviceRequest);

  const deviceSignals = await resolveDeviceSignals(client, {
    workerId: assignment.workerId,
    installationIdHash: input.installationIdHash,
    now: input.now
  });
  const geofence = geofenceSignals(operationPoint, input);

  const validation = evaluateArrivalValidation({
    assignmentActive,
    attendanceEnabled,
    duplicateMark,
    hasConfiguredGeofence: geofence.hasConfiguredGeofence,
    withinGeofence: geofence.withinGeofence,
    accuracyMeters: input.accuracyMeters,
    maxAccuracyMeters: finiteDatabaseNumber(operationPoint?.maxLocationAccuracyMeters) ?? 100,
    authorizedDevice: deviceSignals.authorizedDevice,
    sharedDeviceSignal: deviceSignals.sharedDeviceSignal,
    persistentStorageAvailable: input.persistentStorageAvailable,
    hasFreshPhoto: Boolean(input.hasFreshPhoto && input.evidenceStorageKey),
    minutesLate: minutesLateAt(input.now, expectedWindow.expectedStartAt),
    toleranceMinutes: finiteDatabaseNumber(operationPoint?.lateToleranceMinutes) ?? 0
  });

  if (!validation.canRecordArrival) {
    return {
      recorded: false,
      replayed: false,
      attendanceSession: existingSession,
      attendanceMark: null,
      validation
    };
  }

  const attendanceSession = existingSession ?? await client.dispatchAttendanceSession.create({
    data: {
      assignmentId: assignment.id,
      expectedStartAt: expectedWindow.expectedStartAt,
      expectedEndAt: expectedWindow.expectedEndAt,
      attendanceStatus: 'PENDING',
      validationStatus: 'PENDING',
      source: 'SYSTEM'
    }
  });

  const attendanceMark = await client.dispatchAttendanceMark.create({
    data: {
      attendanceSessionId: attendanceSession.id,
      workerDeviceId: deviceSignals.workerDevice?.id ?? null,
      markType: 'ARRIVAL',
      idempotencyKey: input.idempotencyKey,
      serverReceivedAt: input.now,
      clientCapturedAt: input.clientCapturedAt,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      distanceToPointMeters: geofence.distanceToPointMeters,
      insideGeofence: geofence.withinGeofence,
      installationIdHash: input.installationIdHash,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      evidenceStorageKey: input.evidenceStorageKey,
      evidenceMimeType: input.evidenceMimeType,
      decision: validation.validationStatus,
      riskScore: validation.riskScore,
      riskFlags: validation.riskFlags
    }
  });

  const updatedSession = await client.dispatchAttendanceSession.update({
    where: { id: attendanceSession.id },
    data: {
      attendanceStatus: validation.attendanceStatus,
      validationStatus: validation.validationStatus,
      punctualityStatus: validation.reportedPunctuality,
      riskScore: validation.riskScore,
      riskFlags: validation.riskFlags,
      arrivalReportedAt: input.now,
      arrivalValidatedAt: validation.validationStatus === ATTENDANCE_VALIDATION_STATUS.AUTO_VALIDATED
        ? input.now
        : null
    }
  });

  return {
    recorded: true,
    replayed: false,
    attendanceSession: updatedSession,
    attendanceMark,
    validation
  };
}

function normalizeInput(input) {
  const value = requireInputObject(input, 'attendance_arrival_input');
  const now = value.now === undefined ? new Date() : requiredTimestamp(value.now, 'attendance_server_now');

  return {
    assignmentId: requireNonEmptyString(value.assignmentId, 'assignment_id'),
    idempotencyKey: requireNonEmptyString(value.idempotencyKey, 'idempotency_key'),
    now,
    clientCapturedAt: optionalTimestamp(value.clientCapturedAt, 'client_captured_at'),
    latitude: optionalFiniteNumber(value.latitude, 'latitude', { min: -90, max: 90 }),
    longitude: optionalFiniteNumber(value.longitude, 'longitude', { min: -180, max: 180 }),
    accuracyMeters: optionalFiniteNumber(value.accuracyMeters, 'accuracy_meters', { min: 0 }),
    installationIdHash: optionalString(value.installationIdHash, 'installation_id_hash'),
    ipAddress: optionalString(value.ipAddress, 'ip_address'),
    userAgent: optionalString(value.userAgent, 'user_agent'),
    evidenceStorageKey: optionalString(value.evidenceStorageKey, 'evidence_storage_key'),
    evidenceMimeType: optionalString(value.evidenceMimeType, 'evidence_mime_type'),
    persistentStorageAvailable: value.persistentStorageAvailable === true,
    hasFreshPhoto: value.hasFreshPhoto === true
  };
}

export async function registerDispatchArrival(prisma, input = {}) {
  requirePrismaContract(prisma);
  const normalized = normalizeInput(input);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => registerInsideTransaction(tx, normalized),
        { isolationLevel: SERIALIZABLE_ISOLATION_LEVEL }
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableWriteConflict(error) || attempt === MAX_SERIALIZABLE_RETRIES) break;
    }
  }

  if (lastError?.code === 'P2002') {
    const replay = await findIdempotentReplay(prisma, normalized.idempotencyKey);
    if (replay) return replayResult(replay);
  }

  throw lastError;
}

export { ATTENDANCE_RISK_FLAG };
