export const ATTENDANCE_PHOTO_POLICY = Object.freeze({
  NEVER: 'NEVER',
  RISK_ONLY: 'RISK_ONLY',
  ALWAYS: 'ALWAYS'
});

export const SUPPORTED_ATTENDANCE_TIMEZONES = Object.freeze([
  'America/Bogota'
]);

const PHOTO_POLICIES = new Set(Object.values(ATTENDANCE_PHOTO_POLICY));
const TIMEZONES = new Set(SUPPORTED_ATTENDANCE_TIMEZONES);

const LIMITS = Object.freeze({
  geofenceRadiusMeters: { min: 20, max: 2_000 },
  maxLocationAccuracyMeters: { min: 5, max: 500 },
  earlyArrivalWindowMinutes: { min: 0, max: 240 },
  lateToleranceMinutes: { min: 0, max: 240 },
  absenceGraceMinutes: { min: 0, max: 240 }
});

function requireInputObject(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label}_invalid`);
  }
  return input;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}_required`);
  }
  return value.trim();
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

function parseOptionalFiniteNumber(value, label, fallback, { min, max, integer = false }) {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${label}_invalid`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label}_invalid`);
  }
  return parsed;
}

function parseRequiredInteger(value, label, fallback, limits) {
  const parsed = parseOptionalFiniteNumber(value, label, fallback, { ...limits, integer: true });
  if (parsed === null) throw new Error(`${label}_required`);
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
  const geofenceRadiusMeters = parseOptionalFiniteNumber(
    input.geofenceRadiusMeters,
    'geofence_radius_meters',
    existing.geofenceRadiusMeters,
    { ...LIMITS.geofenceRadiusMeters, integer: true }
  );
  const maxLocationAccuracyMeters = parseOptionalFiniteNumber(
    input.maxLocationAccuracyMeters,
    'max_location_accuracy_meters',
    existing.maxLocationAccuracyMeters,
    { ...LIMITS.maxLocationAccuracyMeters, integer: true }
  );
  const earlyArrivalWindowMinutes = parseRequiredInteger(
    input.earlyArrivalWindowMinutes,
    'early_arrival_window_minutes',
    existing.earlyArrivalWindowMinutes,
    LIMITS.earlyArrivalWindowMinutes
  );
  const lateToleranceMinutes = parseRequiredInteger(
    input.lateToleranceMinutes,
    'late_tolerance_minutes',
    existing.lateToleranceMinutes,
    LIMITS.lateToleranceMinutes
  );
  const absenceGraceMinutes = parseRequiredInteger(
    input.absenceGraceMinutes,
    'absence_grace_minutes',
    existing.absenceGraceMinutes,
    LIMITS.absenceGraceMinutes
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

  if (absenceGraceMinutes < lateToleranceMinutes) {
    throw new Error('absence_grace_before_late_tolerance');
  }

  if (
    geofenceRadiusMeters !== null
    && maxLocationAccuracyMeters !== null
    && maxLocationAccuracyMeters > geofenceRadiusMeters
  ) {
    throw new Error('location_accuracy_exceeds_geofence_radius');
  }

  if (attendanceEnabled) {
    if (existing.isActive !== true) throw new Error('attendance_point_inactive');
    if (attendanceLatitude === null || attendanceLongitude === null) {
      throw new Error('attendance_geofence_coordinates_required');
    }
    if (geofenceRadiusMeters === null) throw new Error('attendance_geofence_radius_required');
    if (maxLocationAccuracyMeters === null) throw new Error('attendance_location_accuracy_required');
  }

  return {
    attendanceEnabled,
    attendanceLatitude,
    attendanceLongitude,
    geofenceRadiusMeters,
    maxLocationAccuracyMeters,
    earlyArrivalWindowMinutes,
    lateToleranceMinutes,
    absenceGraceMinutes,
    attendanceTimezone,
    attendancePhotoPolicy,
    manualAttendanceAllowed
  };
}

export async function updateDispatchAttendancePointConfig(prisma, input = {}) {
  requirePrismaContract(prisma);
  const configInput = requireInputObject(input, 'attendance_point_config_input');
  const clientId = requireNonEmptyString(configInput.clientId, 'client_id');
  const operationPointId = requireNonEmptyString(configInput.operationPointId, 'operation_point_id');

  const existing = await prisma.dispatchOperationPoint.findFirst({
    where: { id: operationPointId, clientId },
    select: {
      id: true,
      clientId: true,
      isActive: true,
      attendanceEnabled: true,
      attendanceLatitude: true,
      attendanceLongitude: true,
      geofenceRadiusMeters: true,
      maxLocationAccuracyMeters: true,
      earlyArrivalWindowMinutes: true,
      lateToleranceMinutes: true,
      absenceGraceMinutes: true,
      attendanceTimezone: true,
      attendancePhotoPolicy: true,
      manualAttendanceAllowed: true
    }
  });

  if (!existing) throw new Error('attendance_operation_point_not_found');

  const data = normalizedConfig(existing, configInput);
  return prisma.dispatchOperationPoint.update({
    where: { id: existing.id },
    data,
    select: {
      id: true,
      clientId: true,
      isActive: true,
      attendanceEnabled: true,
      attendanceLatitude: true,
      attendanceLongitude: true,
      geofenceRadiusMeters: true,
      maxLocationAccuracyMeters: true,
      earlyArrivalWindowMinutes: true,
      lateToleranceMinutes: true,
      absenceGraceMinutes: true,
      attendanceTimezone: true,
      attendancePhotoPolicy: true,
      manualAttendanceAllowed: true,
      updatedAt: true
    }
  });
}
