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
  GEOFENCE_NOT_CONFIGURED: 'GEOFENCE_NOT_CONFIGURED',
  LOCATION_NOT_AVAILABLE: 'LOCATION_NOT_AVAILABLE',
  OUTSIDE_GEOFENCE: 'OUTSIDE_GEOFENCE',
  LOW_LOCATION_ACCURACY: 'LOW_LOCATION_ACCURACY',
  UNAUTHORIZED_DEVICE: 'UNAUTHORIZED_DEVICE',
  SHARED_DEVICE_SIGNAL: 'SHARED_DEVICE_SIGNAL',
  PERSISTENT_STORAGE_UNAVAILABLE: 'PERSISTENT_STORAGE_UNAVAILABLE'
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

/**
 * Evalúa una marcación de llegada sin persistir datos ni depender de Express o Prisma.
 *
 * La ruta normal es la validación automática. La revisión humana solo se exige cuando
 * faltan señales confiables o aparecen indicios de riesgo. Una fotografía reciente puede
 * aportar evidencia, pero nunca convierte por sí sola un dispositivo no autorizado en uno
 * confiable.
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

  const toleranceMinutes = Math.max(0, finiteNumber(input.toleranceMinutes, 0));
  const minutesLate = Math.max(0, finiteNumber(input.minutesLate, 0));
  const maxAccuracyMeters = Math.max(1, finiteNumber(input.maxAccuracyMeters, 100));
  const accuracyMeters = finiteNumber(input.accuracyMeters, null);
  const reportedPunctuality = punctualityFromMinutes(minutesLate, toleranceMinutes);
  const riskFlags = [];
  let riskScore = 0;

  if (input.hasConfiguredGeofence !== true) {
    riskFlags.push(ATTENDANCE_RISK_FLAG.GEOFENCE_NOT_CONFIGURED);
    riskScore += 30;
  } else if (input.withinGeofence !== true && input.withinGeofence !== false) {
    riskFlags.push(ATTENDANCE_RISK_FLAG.LOCATION_NOT_AVAILABLE);
    riskScore += 50;
  } else if (input.withinGeofence === false) {
    riskFlags.push(ATTENDANCE_RISK_FLAG.OUTSIDE_GEOFENCE);
    riskScore += 50;
  }

  if (accuracyMeters === null) {
    if (!riskFlags.includes(ATTENDANCE_RISK_FLAG.LOCATION_NOT_AVAILABLE)) {
      riskFlags.push(ATTENDANCE_RISK_FLAG.LOCATION_NOT_AVAILABLE);
      riskScore += 50;
    }
  } else if (accuracyMeters > maxAccuracyMeters) {
    riskFlags.push(ATTENDANCE_RISK_FLAG.LOW_LOCATION_ACCURACY);
    riskScore += 25;
  }

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
