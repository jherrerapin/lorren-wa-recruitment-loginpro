import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAttendanceDistanceMeters,
  isAttendanceInsideGeofence
} from '../src/modules/dispatch-attendance/domain/attendanceDistance.js';

test('dos coordenadas iguales tienen distancia cero', () => {
  assert.equal(
    calculateAttendanceDistanceMeters(
      { latitude: 4.711, longitude: -74.0721 },
      { latitude: 4.711, longitude: -74.0721 }
    ),
    0
  );
});

test('coordenadas fuera de rango no producen una distancia falsa', () => {
  assert.equal(
    calculateAttendanceDistanceMeters(
      { latitude: 91, longitude: -74.0721 },
      { latitude: 4.711, longitude: -74.0721 }
    ),
    null
  );
});

test('el cálculo permanece finito en puntos antípodas', () => {
  const distance = calculateAttendanceDistanceMeters(
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 180 }
  );

  assert.ok(Number.isFinite(distance));
  assert.ok(distance > 20_000_000 && distance < 20_100_000);
});

test('una geocerca inválida no se interpreta como incumplida', () => {
  assert.equal(isAttendanceInsideGeofence(10, 0), null);
  assert.equal(isAttendanceInsideGeofence(-1, 100), null);
  assert.equal(isAttendanceInsideGeofence(100, 100), true);
});
