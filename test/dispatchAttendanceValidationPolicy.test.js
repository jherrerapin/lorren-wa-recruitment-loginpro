import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_RISK_FLAG,
  ATTENDANCE_STATUS,
  ATTENDANCE_VALIDATION_STATUS,
  evaluateArrivalValidation
} from '../src/modules/dispatch-attendance/domain/attendanceValidationPolicy.js';

function trustedArrival(overrides = {}) {
  return {
    assignmentActive: true,
    attendanceEnabled: true,
    duplicateMark: false,
    hasConfiguredGeofence: true,
    withinGeofence: true,
    accuracyMeters: 15,
    maxAccuracyMeters: 100,
    authorizedDevice: true,
    sharedDeviceSignal: false,
    persistentStorageAvailable: true,
    minutesLate: 0,
    toleranceMinutes: 10,
    hasFreshPhoto: false,
    ...overrides
  };
}

test('auto-valida una llegada confiable sin intervención del coordinador', () => {
  const result = evaluateArrivalValidation(trustedArrival());

  assert.equal(result.canRecordArrival, true);
  assert.equal(result.attendanceStatus, ATTENDANCE_STATUS.ON_TIME);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.AUTO_VALIDATED);
  assert.equal(result.riskScore, 0);
  assert.deepEqual(result.riskFlags, []);
});

test('auto-valida y clasifica como tarde cuando supera la tolerancia', () => {
  const result = evaluateArrivalValidation(trustedArrival({ minutesLate: 11 }));

  assert.equal(result.attendanceStatus, ATTENDANCE_STATUS.LATE);
  assert.equal(result.reportedPunctuality, ATTENDANCE_STATUS.LATE);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.AUTO_VALIDATED);
});

test('registra provisionalmente un dispositivo nuevo y exige revisión', () => {
  const result = evaluateArrivalValidation(trustedArrival({ authorizedDevice: false }));

  assert.equal(result.canRecordArrival, true);
  assert.equal(result.attendanceStatus, ATTENDANCE_STATUS.ARRIVAL_REPORTED);
  assert.equal(result.reportedPunctuality, ATTENDANCE_STATUS.ON_TIME);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REVIEW_REQUIRED);
  assert.ok(result.riskFlags.includes(ATTENDANCE_RISK_FLAG.UNAUTHORIZED_DEVICE));
});

test('rechaza una marcación fuera de la geocerca', () => {
  const result = evaluateArrivalValidation(trustedArrival({ withinGeofence: false }));

  assert.equal(result.canRecordArrival, false);
  assert.equal(result.attendanceStatus, ATTENDANCE_STATUS.PENDING);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REJECTED);
  assert.deepEqual(result.riskFlags, [ATTENDANCE_RISK_FLAG.OUTSIDE_GEOFENCE]);
});

test('rechaza una precisión GPS superior al máximo permitido', () => {
  const result = evaluateArrivalValidation(trustedArrival({ accuracyMeters: 180 }));

  assert.equal(result.canRecordArrival, false);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REJECTED);
  assert.deepEqual(result.riskFlags, [ATTENDANCE_RISK_FLAG.LOW_LOCATION_ACCURACY]);
});

test('una señal de dispositivo compartido produce riesgo crítico y revisión', () => {
  const result = evaluateArrivalValidation(trustedArrival({ sharedDeviceSignal: true }));

  assert.equal(result.canRecordArrival, true);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REVIEW_REQUIRED);
  assert.equal(result.riskLevel, 'CRITICAL');
  assert.ok(result.riskFlags.includes(ATTENDANCE_RISK_FLAG.SHARED_DEVICE_SIGNAL));
});

test('una captura web offline queda pendiente de revisión solo cuando cumple la geocerca', () => {
  const result = evaluateArrivalValidation(trustedArrival({
    captureMode: 'OFFLINE_WEB',
    syncDelayMinutes: 18,
    hasFreshPhoto: true
  }));

  assert.equal(result.canRecordArrival, true);
  assert.equal(result.reportedPunctuality, ATTENDANCE_STATUS.ON_TIME);
  assert.equal(result.attendanceStatus, ATTENDANCE_STATUS.ARRIVAL_REPORTED);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REVIEW_REQUIRED);
  assert.ok(result.riskFlags.includes(ATTENDANCE_RISK_FLAG.OFFLINE_WEB_CAPTURE));
  assert.ok(result.riskFlags.includes(ATTENDANCE_RISK_FLAG.CLIENT_CLOCK_UNTRUSTED));
  assert.ok(result.riskFlags.includes(ATTENDANCE_RISK_FLAG.DELAYED_SYNC));
});

test('rechaza una marcación cuando la asignación no está activa', () => {
  const result = evaluateArrivalValidation(trustedArrival({ assignmentActive: false }));

  assert.equal(result.canRecordArrival, false);
  assert.equal(result.attendanceStatus, ATTENDANCE_STATUS.PENDING);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REJECTED);
  assert.deepEqual(result.riskFlags, [ATTENDANCE_RISK_FLAG.ASSIGNMENT_NOT_ACTIVE]);
});

test('rechaza un segundo intento cuando ya existe una llegada', () => {
  const result = evaluateArrivalValidation(trustedArrival({ duplicateMark: true }));

  assert.equal(result.canRecordArrival, false);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REJECTED);
  assert.deepEqual(result.riskFlags, [ATTENDANCE_RISK_FLAG.DUPLICATE_ARRIVAL]);
});

test('una fotografía reciente aporta evidencia pero no autoriza el dispositivo', () => {
  const withoutPhoto = evaluateArrivalValidation(trustedArrival({ authorizedDevice: false }));
  const withPhoto = evaluateArrivalValidation(trustedArrival({
    authorizedDevice: false,
    hasFreshPhoto: true
  }));

  assert.ok(withPhoto.riskScore < withoutPhoto.riskScore);
  assert.equal(withPhoto.validationStatus, ATTENDANCE_VALIDATION_STATUS.REVIEW_REQUIRED);
  assert.ok(withPhoto.riskFlags.includes(ATTENDANCE_RISK_FLAG.UNAUTHORIZED_DEVICE));
});

test('no habilita marcaciones en puntos donde asistencia sigue desactivada', () => {
  const result = evaluateArrivalValidation(trustedArrival({ attendanceEnabled: false }));

  assert.equal(result.canRecordArrival, false);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REJECTED);
  assert.deepEqual(result.riskFlags, [ATTENDANCE_RISK_FLAG.ATTENDANCE_NOT_ENABLED]);
});

test('rechaza entradas nulas o primitivas sin producir TypeError', () => {
  for (const invalidInput of [null, true, 42, 'invalid', []]) {
    const result = evaluateArrivalValidation(invalidInput);

    assert.equal(result.canRecordArrival, false);
    assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REJECTED);
    assert.deepEqual(result.riskFlags, [ATTENDANCE_RISK_FLAG.ASSIGNMENT_NOT_ACTIVE]);
  }
});

test('rechaza un punto sin geocerca configurada', () => {
  const result = evaluateArrivalValidation(trustedArrival({
    hasConfiguredGeofence: false,
    withinGeofence: undefined,
    accuracyMeters: 15
  }));

  assert.equal(result.canRecordArrival, false);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REJECTED);
  assert.deepEqual(result.riskFlags, [ATTENDANCE_RISK_FLAG.GEOFENCE_NOT_CONFIGURED]);
  assert.equal(result.riskScore, 100);
});

test('rechaza valores numéricos inválidos en la ubicación', () => {
  const result = evaluateArrivalValidation(trustedArrival({
    minutesLate: true,
    toleranceMinutes: [],
    accuracyMeters: {},
    maxAccuracyMeters: false
  }));

  assert.equal(result.canRecordArrival, false);
  assert.equal(result.reportedPunctuality, null);
  assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REJECTED);
  assert.deepEqual(result.riskFlags, [ATTENDANCE_RISK_FLAG.LOCATION_NOT_AVAILABLE]);
});
