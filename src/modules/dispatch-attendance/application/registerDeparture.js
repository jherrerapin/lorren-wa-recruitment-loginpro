import {
  ATTENDANCE_VALIDATION_STATUS,
  evaluateArrivalValidation
} from '../domain/attendanceValidationPolicy.js';
import {
  calculateAttendanceDistanceMeters,
  isAttendanceInsideGeofence
} from '../domain/attendanceDistance.js';
import { calculateDispatchWorkedTime } from '../domain/attendanceWorkdayPolicy.js';
import {
  getDispatchAttendanceBreakPolicy
} from '../infrastructure/dispatchAttendanceBreakPolicyRepository.js';
import {
  ACTIVE_DISPATCH_ASSIGNMENT_STATUSES,
  buildDispatchAttendanceExpectedWindow
} from './registerArrival.js';

const ACTIVE_ASSIGNMENT_STATUS_SET = new Set(ACTIVE_DISPATCH_ASSIGNMENT_STATUSES);
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

function normalizeCaptureMode(value) {
  const normalized = value === undefined || value === null || value === ''
    ? ONLINE_WEB_CAPTURE_MODE
    : requireString(value, 'attendance_capture_mode').toUpperCase();
  if (![ONLINE_WEB_CAPTURE_MODE, OFFLINE_WEB_CAPTURE_MODE].includes(normalized)) {
    throw new Error('attendance_capture_mode_invalid');
  }
  return normalized;
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
  return {
    assignmentId: requireString(input.assignmentId, 'assignment_id'),
    expectedWorkerId: optionalString(input.expectedWorkerId, 'expected_worker_id'),
    idempotencyKey: requireString(input.idempotencyKey, 'idempotency_key'),
    now,
    reportedAt,
    clientCapturedAt,
    captureMode,
    latitude: numberValue(input.latitude, 'latitude', -90, 90),
    longitude: numberValue(input.longitude, 'longitude', -180, 180),
    accuracyMeters: numberValue(input.accuracyMeters, 'accuracy_meters', 0, 100_000),
    installationIdHash: optionalString(input.installationIdHash, 'installation_id_hash'),
    ipAddress: optionalString(input.ipAddress, 'ip_address'),
    userAgent: optionalString(input.userAgent, 'user_agent'),
    evidenceStorageKey: optionalString(input.evidenceStorageKey, 'evidence_storage_key'),
    evidenceMimeType: optionalString(input.evidenceMimeType, 'evidence_mime_type'),
    persistentStorageAvailable: input.persistentStorageAvailable === true,
    hasFreshPhoto: input.hasFreshPhoto === true
  };
}

function requirePrisma(prisma) {
  const required = {
    dispatchAssignment: ['findUnique'],
    dispatchAttendanceSession: ['update'],
    dispatchAttendanceMark: ['findUnique', 'create'],
    dispatchWorkerDevice: ['findFirst', 'count']
  };
  if (typeof prisma?.$transaction !== 'function') throw new Error('attendance_departure_transaction_required');
  for (const [modelName, methods] of Object.entries(required)) {
    if (!prisma[modelName] || methods.some((method) => typeof prisma[modelName][method] !== 'function')) {
      throw new Error(`attendance_departure_${modelName}_contract_invalid`);
    }
  }
}

async function deviceSignals(client, input) {
  if (!input.installationIdHash) {
    return { authorizedDevice: false, sharedDeviceSignal: false, workerDevice: null };
  }
  const activeWindow = {
    status: 'ACTIVE',
    revokedAt: null,
    authorizedFrom: { lte: input.now },
    OR: [{ authorizedUntil: null }, { authorizedUntil: { gte: input.now } }]
  };
  const [workerDevice, sharedCount] = await Promise.all([
    client.dispatchWorkerDevice.findFirst({
      where: {
        workerId: input.workerId,
        installationIdHash: input.installationIdHash,
        ...activeWindow
      }
    }),
    client.dispatchWorkerDevice.count({
      where: {
        installationIdHash: input.installationIdHash,
        workerId: { not: input.workerId },
        ...activeWindow
      }
    })
  ]);
  return { authorizedDevice: Boolean(workerDevice), sharedDeviceSignal: sharedCount > 0, workerDevice };
}

function geofenceSignals(point, input) {
  const pointLat = Number(point?.attendanceLatitude);
  const pointLng = Number(point?.attendanceLongitude);
  const radius = Number(point?.geofenceRadiusMeters);
  const configured = Number.isFinite(pointLat) && Number.isFinite(pointLng) && Number.isFinite(radius) && radius > 0;
  const distance = calculateAttendanceDistanceMeters(
    { latitude: pointLat, longitude: pointLng },
    { latitude: input.latitude, longitude: input.longitude }
  );
  return {
    configured,
    distance,
    inside: configured ? isAttendanceInsideGeofence(distance, radius) : null
  };
}

function mergeFlags(...values) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : []))];
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
      riskFlags: Array.isArray(mark.riskFlags) ? mark.riskFlags : [],
      workedMinutes: mark.attendanceSession?.workedMinutes ?? null
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
  const session = assignment.attendanceSession;
  if (!ACTIVE_ASSIGNMENT_STATUS_SET.has(assignment.status)) throw new Error('attendance_assignment_inactive');
  if (assignment.serviceRequest.operationPoint?.attendanceEnabled !== true) throw new Error('attendance_not_enabled');
  if (!session?.arrivalReportedAt) throw new Error('attendance_departure_arrival_required');
  if (session.departureReportedAt) throw new Error('attendance_departure_already_registered');
  if (input.reportedAt.getTime() < session.arrivalReportedAt.getTime()) {
    throw new Error('attendance_departure_before_arrival');
  }

  const point = assignment.serviceRequest.operationPoint;
  const [device, breakPolicy] = await Promise.all([
    deviceSignals(client, { ...input, workerId: assignment.workerId }),
    getDispatchAttendanceBreakPolicy(client, assignment.serviceRequestId)
  ]);
  const geofence = geofenceSignals(point, input);
  const syncDelayMinutes = Math.max(0, Math.floor((input.now.getTime() - input.reportedAt.getTime()) / 60_000));
  const departureValidation = evaluateArrivalValidation({
    assignmentActive: true,
    attendanceEnabled: true,
    duplicateMark: false,
    arrivalWindowOpen: true,
    hasConfiguredGeofence: geofence.configured,
    withinGeofence: geofence.inside,
    accuracyMeters: input.accuracyMeters,
    maxAccuracyMeters: Number(point?.maxLocationAccuracyMeters) || 100,
    authorizedDevice: device.authorizedDevice,
    sharedDeviceSignal: device.sharedDeviceSignal,
    persistentStorageAvailable: input.persistentStorageAvailable,
    hasFreshPhoto: Boolean(input.hasFreshPhoto && input.evidenceStorageKey),
    minutesLate: 0,
    toleranceMinutes: 0,
    captureMode: input.captureMode,
    syncDelayMinutes
  });

  const expected = session.expectedStartAt
    ? { expectedStartAt: session.expectedStartAt, expectedEndAt: session.expectedEndAt }
    : buildDispatchAttendanceExpectedWindow(assignment.serviceRequest);
  const work = calculateDispatchWorkedTime({
    arrivalAt: session.arrivalReportedAt,
    departureAt: input.reportedAt,
    expectedStartAt: expected.expectedStartAt,
    expectedEndAt: expected.expectedEndAt,
    unpaidBreakMinutes: breakPolicy.unpaidBreakMinutes
  });
  const priorStatus = session.validationStatus;
  let validationStatus = departureValidation.validationStatus;
  if (priorStatus === 'REVIEW_REQUIRED' || priorStatus === 'REJECTED') validationStatus = 'REVIEW_REQUIRED';
  if (priorStatus === 'MANUAL_VALIDATED' && validationStatus === ATTENDANCE_VALIDATION_STATUS.AUTO_VALIDATED) {
    validationStatus = 'MANUAL_VALIDATED';
  }
  const riskFlags = mergeFlags(session.riskFlags, departureValidation.riskFlags);
  const riskScore = Math.max(Number(session.riskScore) || 0, departureValidation.riskScore || 0);

  const mark = await client.dispatchAttendanceMark.create({
    data: {
      attendanceSessionId: session.id,
      workerDeviceId: device.workerDevice?.id ?? null,
      markType: 'DEPARTURE',
      idempotencyKey: input.idempotencyKey,
      serverReceivedAt: input.now,
      clientCapturedAt: input.clientCapturedAt ?? input.reportedAt,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      distanceToPointMeters: geofence.distance,
      insideGeofence: geofence.inside,
      installationIdHash: input.installationIdHash,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      evidenceStorageKey: input.evidenceStorageKey,
      evidenceMimeType: input.evidenceMimeType,
      decision: validationStatus,
      riskScore: departureValidation.riskScore,
      riskFlags: departureValidation.riskFlags
    }
  });

  const updated = await client.dispatchAttendanceSession.update({
    where: { id: session.id },
    data: {
      attendanceStatus: validationStatus === ATTENDANCE_VALIDATION_STATUS.AUTO_VALIDATED
        || validationStatus === 'MANUAL_VALIDATED'
        ? 'COMPLETED'
        : 'DEPARTURE_REPORTED',
      validationStatus,
      riskScore,
      riskFlags,
      departureReportedAt: input.reportedAt,
      departureValidatedAt: validationStatus === ATTENDANCE_VALIDATION_STATUS.AUTO_VALIDATED ? input.now : null,
      workedMinutes: work.workedMinutes
    }
  });

  return {
    recorded: true,
    replayed: false,
    attendanceSession: updated,
    attendanceMark: mark,
    validation: {
      validationStatus,
      riskScore,
      riskFlags,
      breakPolicy,
      ...work
    }
  };
}

export async function registerDispatchDeparture(prisma, input = {}) {
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
