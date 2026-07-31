export const ATTENDANCE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ARRIVAL_REPORTED: 'ARRIVAL_REPORTED',
  ON_TIME: 'ON_TIME',
  LATE: 'LATE'
});

export const ATTENDANCE_VALIDATION_STATUS = Object.freeze({
  AUTO_VALIDATED: 'AUTO_VALIDATED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  REJECTED: 'REJECTED'
});

export const ATTENDANCE_RISK_FLAG = Object.freeze({
  ASSIGNMENT_NOT_ACTIVE: 'ASSIGNMENT_NOT_ACTIVE',
  ATTENDANCE_NOT_ENABLED: 'ATTENDANCE_NOT_ENABLED',
  DUPLICATE_ARRIVAL: 'DUPLICATE_ARRIVAL',
  ARRIVAL_WINDOW_NOT_OPEN: 'ARRIVAL_WINDOW_NOT_OPEN',
  GEOFENCE_NOT_CONFIGURED: 'GEOFENCE_NOT_CONFIGURED',
  LOCATION_NOT_AVAILABLE: 'LOCATION_NOT_AVAILABLE',
  OUTSIDE_GEOFENCE: 'OUTSIDE_GEOFENCE',
  LOW_LOCATION_ACCURACY: 'LOW_LOCATION_ACCURACY',
  UNAUTHORIZED_DEVICE: 'UNAUTHORIZED_DEVICE',
  SHARED_DEVICE_SIGNAL: 'SHARED_DEVICE_SIGNAL',
  PERSISTENT_STORAGE_UNAVAILABLE: 'PERSISTENT_STORAGE_UNAVAILABLE',
  OFFLINE_WEB_CAPTURE: 'OFFLINE_WEB_CAPTURE',
  CLIENT_CLOCK_UNTRUSTED: 'CLIENT_CLOCK_UNTRUSTED',
  DELAYED_SYNC: 'DELAYED_SYNC'
});

function finiteNumber(value, fallback) {
  const isSupportedType = typeof value === 'number' || typeof value === 'string';
  if (!isSupportedType || value === '') return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampRiskScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function riskLevelFromScore(score) {
  if (score >= 80) return 'CRITICAL';
  if (score >= 50) return 'HIGH';
  if (score >= 25) return 'MEDIUM';
  return 'LOW';
}

function punctualityFromMinutes(minutesLate, toleranceMinutes) {
  return minutesLate > toleranceMinutes
    ? ATTENDANCE_STATUS.LATE
    : ATTENDANCE_STATUS.ON_TIME;
}

function rejectedResult(flag) {
  return {
    canRecordArrival: false,
    attendanceStatus: ATTENDANCE_STATUS.PENDING,
    reportedPunctuality: null,
    validationStatus: ATTENDANCE_VALIDATION_STATUS.REJECTED,
    riskScore: 100,
    riskLevel: 'CRITICAL',
    riskFlags: [flag]
  };
}

function requiredGeofenceRejection(input, accuracyMeters, maxAccuracyMeters) {
  if (input.hasConfiguredGeofence !== true) {
    return ATTENDANCE_RISK_FLAG.GEOFENCE_NOT_CONFIGURED;
  }
  if (input.withinGeofence !== true && input.withinGeofence !== false) {
    return ATTENDANCE_RISK_FLAG.LOCATION_NOT_AVAILABLE;
  }
  if (input.withinGeofence === false) {
    return ATTENDANCE_RISK_FLAG.OUTSIDE_GEOFENCE;
  }
  if (accuracyMeters === null) {
    return ATTENDANCE_RISK_FLAG.LOCATION_NOT_AVAILABLE;
  }
  if (accuracyMeters > maxAccuracyMeters) {
    return ATTENDANCE_RISK_FLAG.LOW_LOCATION_ACCURACY;
  }
  return null;
}

/**
 * Evalúa una marcación de llegada sin persistir datos ni depender de Express o Prisma.
 *
 * La geocerca es una condición obligatoria: una operación sin punto válido, una ubicación
 * ausente, una precisión insuficiente o una posición fuera del radio rechazan la marca.
 * La revisión humana se reserva para señales posteriores como dispositivo no autorizado,
 * almacenamiento no persistente o una captura web offline que sí cumplió la geocerca.
 */
export function evaluateArrivalValidation(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return rejectedResult(ATTENDANCE_RISK_FLAG.ASSIGNMENT_NOT_ACTIVE);
  }

  if (input.assignmentActive !== true) {
    return rejectedResult(ATTENDANCE_RISK_FLAG.ASSIGNMENT_NOT_ACTIVE);
  }

  if (input.attendanceEnabled !== true) {
    return rejectedResult(ATTENDANCE_RISK_FLAG.ATTENDANCE_NOT_ENABLED);
  }

  if (input.duplicateMark === true) {
    return rejectedResult(ATTENDANCE_RISK_FLAG.DUPLICATE_ARRIVAL);
  }

  if (input.arrivalWindowOpen === false) {
    return rejectedResult(ATTENDANCE_RISK_FLAG.ARRIVAL_WINDOW_NOT_OPEN);
  }

  const toleranceMinutes = Math.max(0, finiteNumber(input.toleranceMinutes, 0));
  const minutesLate = Math.max(0, finiteNumber(input.minutesLate, 0));
  const maxAccuracyMeters = Math.max(1, finiteNumber(input.maxAccuracyMeters, 100));
  const accuracyMeters = finiteNumber(input.accuracyMeters, null);
  const geofenceRejection = requiredGeofenceRejection(input, accuracyMeters, maxAccuracyMeters);
  if (geofenceRejection) return rejectedResult(geofenceRejection);

  const syncDelayMinutes = Math.max(0, finiteNumber(input.syncDelayMinutes, 0));
  const reportedPunctuality = punctualityFromMinutes(minutesLate, toleranceMinutes);
  const riskFlags = [];
  let riskScore = 0;

  if (input.authorizedDevice !== true) {
    riskFlags.push(ATTENDANCE_RISK_FLAG.UNAUTHORIZED_DEVICE);
    riskScore += 40;
  }

  if (input.sharedDeviceSignal === true) {
    riskFlags.push(ATTENDANCE_RISK_FLAG.SHARED_DEVICE_SIGNAL);
    riskScore += 80;
  }

  if (input.persistentStorageAvailable === false) {
    riskFlags.push(ATTENDANCE_RISK_FLAG.PERSISTENT_STORAGE_UNAVAILABLE);
    riskScore += 20;
  }

  if (input.captureMode === 'OFFLINE_WEB') {
    riskFlags.push(ATTENDANCE_RISK_FLAG.OFFLINE_WEB_CAPTURE);
    riskFlags.push(ATTENDANCE_RISK_FLAG.CLIENT_CLOCK_UNTRUSTED);
    riskScore += 40;
    if (syncDelayMinutes >= 5) {
      riskFlags.push(ATTENDANCE_RISK_FLAG.DELAYED_SYNC);
      riskScore += Math.min(25, 10 + Math.floor(syncDelayMinutes / 60) * 5);
    }
  }

  if (input.hasFreshPhoto === true && riskScore > 0) {
    riskScore -= 10;
  }

  const normalizedRiskScore = clampRiskScore(riskScore);
  const canAutoValidate = riskFlags.length === 0;

  return {
    canRecordArrival: true,
    attendanceStatus: canAutoValidate
      ? reportedPunctuality
      : ATTENDANCE_STATUS.ARRIVAL_REPORTED,
    reportedPunctuality,
    validationStatus: canAutoValidate
      ? ATTENDANCE_VALIDATION_STATUS.AUTO_VALIDATED
      : ATTENDANCE_VALIDATION_STATUS.REVIEW_REQUIRED,
    riskScore: normalizedRiskScore,
    riskLevel: riskLevelFromScore(normalizedRiskScore),
    riskFlags
  };
}
