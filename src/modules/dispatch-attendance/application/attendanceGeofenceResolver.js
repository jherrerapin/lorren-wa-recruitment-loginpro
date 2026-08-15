import {
  calculateAttendanceDistanceMeters,
  isAttendanceInsideGeofence
} from '../domain/attendanceDistance.js';

function finiteNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function operationId(point) {
  return typeof point?.id === 'string' && point.id.trim() ? point.id.trim() : null;
}

function evaluatePoint(point, input = {}) {
  const pointLatitude = finiteNumber(point?.attendanceLatitude, { min: -90, max: 90 });
  const pointLongitude = finiteNumber(point?.attendanceLongitude, { min: -180, max: 180 });
  const radiusMeters = finiteNumber(point?.geofenceRadiusMeters, { min: 1, max: 100_000 });
  const latitude = finiteNumber(input.latitude, { min: -90, max: 90 });
  const longitude = finiteNumber(input.longitude, { min: -180, max: 180 });
  const accuracyMeters = finiteNumber(input.accuracyMeters, { min: 0, max: 100_000 });
  const configured = pointLatitude !== null && pointLongitude !== null && radiusMeters !== null;
  const locationAvailable = latitude !== null && longitude !== null;
  const distanceMeters = configured && locationAvailable
    ? calculateAttendanceDistanceMeters(
        { latitude: pointLatitude, longitude: pointLongitude },
        { latitude, longitude }
      )
    : null;
  const insideGeofence = distanceMeters === null
    ? null
    : isAttendanceInsideGeofence(distanceMeters, radiusMeters);
  const maxAccuracyMeters = finiteNumber(point?.maxLocationAccuracyMeters, { min: 1, max: 100_000 }) ?? 100;

  return {
    operationPointId: operationId(point),
    configured,
    locationAvailable,
    accuracyMeters,
    maxAccuracyMeters,
    distanceMeters,
    insideGeofence
  };
}

function acceptance(signals, sourceOperationPointId) {
  if (!signals.locationAvailable || signals.accuracyMeters === null) {
    return { ...signals, accepted: false, errorCode: 'attendance_location_required' };
  }
  if (!signals.configured) {
    return { ...signals, accepted: false, errorCode: 'attendance_operation_geofence_required' };
  }
  if (signals.insideGeofence !== true) {
    return { ...signals, accepted: false, errorCode: 'attendance_outside_operation_range' };
  }
  if (signals.accuracyMeters > signals.maxAccuracyMeters) {
    return { ...signals, accepted: false, errorCode: 'attendance_location_accuracy_insufficient' };
  }
  return {
    ...signals,
    accepted: true,
    errorCode: null,
    crossOperation: Boolean(
      sourceOperationPointId
      && signals.operationPointId
      && signals.operationPointId !== sourceOperationPointId
    )
  };
}

function requireOperationLookup(prisma) {
  if (!prisma?.dispatchOperationPoint || typeof prisma.dispatchOperationPoint.findMany !== 'function') {
    throw new Error('attendance_geofence_operation_lookup_contract_invalid');
  }
  return prisma.dispatchOperationPoint;
}

export async function resolveAttendanceOperationGeofence(
  prisma,
  sourceOperationPoint,
  input = {},
  options = {}
) {
  const sourceOperationPointId = operationId(sourceOperationPoint);
  const sourceSignals = evaluatePoint(sourceOperationPoint, input);
  const sourceAcceptance = acceptance(sourceSignals, sourceOperationPointId);

  // La operación de la asignación siempre tiene prioridad si la ubicación cae dentro de ella.
  // Esto evita escoger otra operación solapada para eludir su precisión configurada.
  if (sourceSignals.insideGeofence === true) return sourceAcceptance;

  const crossOperationAllowed = options.allowCrossOperation !== false
    && sourceOperationPoint?.crossOperationAttendanceAllowed === true;
  if (!crossOperationAllowed || !sourceSignals.locationAvailable || sourceSignals.accuracyMeters === null) {
    return sourceAcceptance;
  }

  const operationModel = requireOperationLookup(prisma);
  const alternatives = await operationModel.findMany({
    where: {
      id: sourceOperationPointId ? { not: sourceOperationPointId } : undefined,
      isActive: true,
      attendanceEnabled: true
    },
    select: {
      id: true,
      isActive: true,
      attendanceEnabled: true,
      attendanceLatitude: true,
      attendanceLongitude: true,
      geofenceRadiusMeters: true,
      maxLocationAccuracyMeters: true
    }
  });

  const evaluated = (Array.isArray(alternatives) ? alternatives : [])
    .filter((point) => (
      point?.isActive === true
      && point?.attendanceEnabled === true
      && operationId(point) !== sourceOperationPointId
    ))
    .map((point) => acceptance(evaluatePoint(point, input), sourceOperationPointId))
    .filter((result) => result.configured && result.insideGeofence === true)
    .sort((left, right) => (left.distanceMeters ?? Infinity) - (right.distanceMeters ?? Infinity));

  const accepted = evaluated.find((result) => result.accepted);
  if (accepted) return accepted;

  // Si físicamente está dentro de una operación registrada pero la precisión no alcanza,
  // se conserva ese rechazo en vez de degradarlo a "fuera de rango".
  if (evaluated.length) return evaluated[0];
  return sourceAcceptance;
}

export function assertAttendanceOperationGeofence(result) {
  if (result?.accepted === true) return result;
  throw new Error(result?.errorCode || 'attendance_outside_operation_range');
}
