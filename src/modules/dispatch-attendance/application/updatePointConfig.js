export const ATTENDANCE_PHOTO_POLICY = Object.freeze({
  NEVER: 'NEVER',
  RISK_ONLY: 'RISK_ONLY',
  ALWAYS: 'ALWAYS'
});

export const SUPPORTED_ATTENDANCE_TIMEZONES = Object.freeze([
  'America/Bogota'
]);

export const DEFAULT_ATTENDANCE_GEOFENCE_RADIUS_METERS = 100;
export const DEFAULT_ATTENDANCE_MAX_LOCATION_ACCURACY_METERS = 50;
export const ATTENDANCE_POINT_ENABLEMENT_ENTITY_TYPE = 'DISPATCH_ATTENDANCE_POINT_ENABLEMENT';
export const ATTENDANCE_POINT_ENABLEMENT_ACTION = 'ATTENDANCE_POINT_ENABLEMENT_CHANGED';

const PHOTO_POLICIES = new Set(Object.values(ATTENDANCE_PHOTO_POLICY));
const TIMEZONES = new Set(SUPPORTED_ATTENDANCE_TIMEZONES);

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

function normalizeOptionalString(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function parseExplicitBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  if (typeof value !== 'string') throw new Error(`${label}_invalid`);
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'off') return false;
  throw new Error(`${label}_invalid`);
}

function parseOptionalFiniteNumber(value, label, fallback, { min, max }) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label}_invalid`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${label}_invalid`);
  return parsed;
}

function parseAllowedString(value, label, fallback, allowed) {
  if (value === undefined) return fallback;
  const normalized = requireNonEmptyString(value, label);
  if (!allowed.has(normalized)) throw new Error(`${label}_not_allowed`);
  return normalized;
}

function requirePrismaContract(client) {
  const model = client?.dispatchOperationPoint;
  if (!model || typeof model.findFirst !== 'function' || typeof model.update !== 'function') {
    throw new Error('attendance_point_config_prisma_contract_invalid');
  }
  return client;
}

function normalizedConfig(existing, input) {
  const attendanceEnabled = parseExplicitBoolean(
    input.attendanceEnabled,
    'attendance_enabled',
    existing.attendanceEnabled
  );
  const manualAttendanceAllowed = parseExplicitBoolean(
    input.manualAttendanceAllowed,
    'manual_attendance_allowed',
    existing.manualAttendanceAllowed
  );
  const crossOperationAttendanceAllowed = parseExplicitBoolean(
    input.crossOperationAttendanceAllowed,
    'cross_operation_attendance_allowed',
    existing.crossOperationAttendanceAllowed
  );
  const attendanceLatitude = parseOptionalFiniteNumber(
    input.attendanceLatitude,
    'attendance_latitude',
    existing.attendanceLatitude === null ? null : Number(existing.attendanceLatitude),
    { min: -90, max: 90 }
  );
  const attendanceLongitude = parseOptionalFiniteNumber(
    input.attendanceLongitude,
    'attendance_longitude',
    existing.attendanceLongitude === null ? null : Number(existing.attendanceLongitude),
    { min: -180, max: 180 }
  );
  const attendanceTimezone = parseAllowedString(
    input.attendanceTimezone,
    'attendance_timezone',
    existing.attendanceTimezone,
    TIMEZONES
  );
  const attendancePhotoPolicy = parseAllowedString(
    input.attendancePhotoPolicy,
    'attendance_photo_policy',
    existing.attendancePhotoPolicy,
    PHOTO_POLICIES
  );

  if (attendanceEnabled) {
    if (existing.isActive !== true) throw new Error('attendance_point_inactive');
    if (attendanceLatitude === null || attendanceLongitude === null) {
      throw new Error('attendance_geofence_coordinates_required');
    }
  }

  return {
    attendanceEnabled,
    attendanceLatitude,
    attendanceLongitude,
    geofenceRadiusMeters: attendanceEnabled
      ? DEFAULT_ATTENDANCE_GEOFENCE_RADIUS_METERS
      : existing.geofenceRadiusMeters,
    maxLocationAccuracyMeters: attendanceEnabled
      ? DEFAULT_ATTENDANCE_MAX_LOCATION_ACCURACY_METERS
      : existing.maxLocationAccuracyMeters,
    attendanceTimezone,
    attendancePhotoPolicy,
    manualAttendanceAllowed,
    crossOperationAttendanceAllowed
  };
}

const POINT_SELECT = {
  id: true,
  clientId: true,
  isActive: true,
  attendanceEnabled: true,
  attendanceLatitude: true,
  attendanceLongitude: true,
  geofenceRadiusMeters: true,
  maxLocationAccuracyMeters: true,
  attendanceTimezone: true,
  attendancePhotoPolicy: true,
  manualAttendanceAllowed: true,
  crossOperationAttendanceAllowed: true,
  updatedAt: true
};

async function updateAndAudit(client, existing, config, input) {
  const updated = await client.dispatchOperationPoint.update({
    where: { id: existing.id },
    data: config,
    select: POINT_SELECT
  });
  if (
    existing.attendanceEnabled !== updated.attendanceEnabled
    && client?.devAuditEvent
    && typeof client.devAuditEvent.create === 'function'
  ) {
    await client.devAuditEvent.create({
      data: {
        entityType: ATTENDANCE_POINT_ENABLEMENT_ENTITY_TYPE,
        entityId: existing.id,
        entityLabel: `Asistencia operación ${existing.id}`,
        action: ATTENDANCE_POINT_ENABLEMENT_ACTION,
        actorUsername: normalizeOptionalString(input.actorUsername, 160),
        actorRole: normalizeOptionalString(input.actorRole, 80),
        actorSource: 'attendance-point-config',
        ipAddress: normalizeOptionalString(input.ipAddress, 120),
        userAgent: normalizeOptionalString(input.userAgent, 500),
        fromValue: { attendanceEnabled: existing.attendanceEnabled === true },
        toValue: { attendanceEnabled: updated.attendanceEnabled === true },
        metadata: {
          operationPointId: existing.id,
          previousAttendanceEnabled: existing.attendanceEnabled === true,
          attendanceEnabled: updated.attendanceEnabled === true
        }
      }
    });
  }
  return updated;
}

export async function updateDispatchAttendancePointConfig(prisma, input = {}) {
  requirePrismaContract(prisma);
  const configInput = requireInputObject(input, 'attendance_point_config_input');
  const clientId = requireNonEmptyString(configInput.clientId, 'client_id');
  const operationPointId = requireNonEmptyString(configInput.operationPointId, 'operation_point_id');

  const existing = await prisma.dispatchOperationPoint.findFirst({
    where: { id: operationPointId, clientId },
    select: POINT_SELECT
  });
  if (!existing) throw new Error('attendance_operation_point_not_found');
  const config = normalizedConfig(existing, configInput);

  const supportsAuditedTransaction = typeof prisma.$transaction === 'function'
    && prisma?.devAuditEvent
    && typeof prisma.devAuditEvent.create === 'function';
  if (supportsAuditedTransaction) {
    return prisma.$transaction((tx) => updateAndAudit(tx, existing, config, configInput));
  }
  return updateAndAudit(prisma, existing, config, configInput);
}
