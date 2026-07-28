const EARTH_RADIUS_METERS = 6_371_008.8;
export const ATTENDANCE_TEST_GEOFENCE_BYPASS_RADIUS_SENTINEL_METERS = 99_999;

function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validLatitude(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= -90 && parsed <= 90 ? parsed : null;
}

function validLongitude(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= -180 && parsed <= 180 ? parsed : null;
}

function toRadians(value) {
  return value * (Math.PI / 180);
}

/**
 * Calcula la distancia mínima sobre la superficie terrestre mediante Haversine.
 * Devuelve null cuando falta alguna coordenada o está fuera de rango.
 */
export function calculateAttendanceDistanceMeters(origin = {}, destination = {}) {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
  if (!destination || typeof destination !== 'object' || Array.isArray(destination)) return null;

  const originLatitude = validLatitude(origin.latitude);
  const originLongitude = validLongitude(origin.longitude);
  const destinationLatitude = validLatitude(destination.latitude);
  const destinationLongitude = validLongitude(destination.longitude);

  if (
    originLatitude === null
    || originLongitude === null
    || destinationLatitude === null
    || destinationLongitude === null
  ) {
    return null;
  }

  const latitudeDelta = toRadians(destinationLatitude - originLatitude);
  const longitudeDelta = toRadians(destinationLongitude - originLongitude);
  const originLatitudeRadians = toRadians(originLatitude);
  const destinationLatitudeRadians = toRadians(destinationLatitude);

  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(originLatitudeRadians)
      * Math.cos(destinationLatitudeRadians)
      * Math.sin(longitudeDelta / 2) ** 2;
  const normalizedHaversine = Math.max(0, Math.min(1, haversine));
  const angularDistance = 2 * Math.atan2(
    Math.sqrt(normalizedHaversine),
    Math.sqrt(1 - normalizedHaversine)
  );

  return Math.round(EARTH_RADIUS_METERS * angularDistance * 100) / 100;
}

export function isAttendanceInsideGeofence(distanceMeters, radiusMeters) {
  const distance = finiteNumber(distanceMeters);
  const radius = finiteNumber(radiusMeters);
  if (distance === null || radius === null || distance < 0 || radius <= 0) return null;
  if (radius === ATTENDANCE_TEST_GEOFENCE_BYPASS_RADIUS_SENTINEL_METERS) return true;
  return distance <= radius;
}
