import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_PHOTO_POLICY,
  DEFAULT_ATTENDANCE_GEOFENCE_RADIUS_METERS,
  DEFAULT_ATTENDANCE_MAX_LOCATION_ACCURACY_METERS,
  SUPPORTED_ATTENDANCE_TIMEZONES,
  updateDispatchAttendancePointConfig
} from '../src/modules/dispatch-attendance/application/updatePointConfig.js';

function basePoint(overrides = {}) {
  return {
    id: 'point-1',
    clientId: 'client-1',
    isActive: true,
    attendanceEnabled: false,
    attendanceLatitude: null,
    attendanceLongitude: null,
    geofenceRadiusMeters: null,
    maxLocationAccuracyMeters: null,
    attendanceTimezone: 'America/Bogota',
    attendancePhotoPolicy: 'RISK_ONLY',
    manualAttendanceAllowed: true,
    ...overrides
  };
}

function createPrisma(point = basePoint()) {
  const writes = [];
  return {
    writes,
    dispatchOperationPoint: {
      async findFirst({ where }) {
        return point && point.id === where.id && point.clientId === where.clientId ? { ...point } : null;
      },
      async update({ where, data }) {
        writes.push({ where, data });
        return { ...point, ...data, updatedAt: new Date('2026-07-19T03:00:00.000Z') };
      }
    }
  };
}

function validInput(overrides = {}) {
  return {
    clientId: 'client-1',
    operationPointId: 'point-1',
    attendanceEnabled: true,
    attendanceLatitude: 4.711,
    attendanceLongitude: -74.0721,
    geofenceRadiusMeters: 1_900,
    maxLocationAccuracyMeters: 400,
    attendanceTimezone: 'America/Bogota',
    attendancePhotoPolicy: 'RISK_ONLY',
    manualAttendanceAllowed: true,
    ...overrides
  };
}

async function rejectsWithoutWrite(input, expectedMessage, point = basePoint()) {
  const prisma = createPrisma(point);
  await assert.rejects(
    () => updateDispatchAttendancePointConfig(prisma, input),
    { message: expectedMessage }
  );
  assert.equal(prisma.writes.length, 0);
}

test('activa un punto con ubicación completa y aplica estándares protegidos', async () => {
  const prisma = createPrisma();
  const result = await updateDispatchAttendancePointConfig(prisma, validInput());
  assert.equal(result.attendanceEnabled, true);
  assert.equal(result.geofenceRadiusMeters, DEFAULT_ATTENDANCE_GEOFENCE_RADIUS_METERS);
  assert.equal(result.maxLocationAccuracyMeters, DEFAULT_ATTENDANCE_MAX_LOCATION_ACCURACY_METERS);
  assert.deepEqual(Object.keys(prisma.writes[0].data).sort(), [
    'attendanceEnabled',
    'attendanceLatitude',
    'attendanceLongitude',
    'attendancePhotoPolicy',
    'attendanceTimezone',
    'geofenceRadiusMeters',
    'manualAttendanceAllowed',
    'maxLocationAccuracyMeters'
  ]);
});

test('ignora por completo parámetros antiguos de ventanas y tolerancias', async () => {
  const prisma = createPrisma();
  await updateDispatchAttendancePointConfig(prisma, validInput({
    earlyArrivalWindowMinutes: 999,
    lateToleranceMinutes: -10,
    absenceGraceMinutes: 'no-aplica'
  }));
  assert.equal(Object.hasOwn(prisma.writes[0].data, 'earlyArrivalWindowMinutes'), false);
  assert.equal(Object.hasOwn(prisma.writes[0].data, 'lateToleranceMinutes'), false);
  assert.equal(Object.hasOwn(prisma.writes[0].data, 'absenceGraceMinutes'), false);
});

test('rechaza activar sin coordenadas', async () => {
  await rejectsWithoutWrite(
    validInput({ attendanceLatitude: '', attendanceLongitude: '' }),
    'attendance_geofence_coordinates_required'
  );
});

test('rechaza coordenadas fuera de rango', async () => {
  await rejectsWithoutWrite(validInput({ attendanceLatitude: 91 }), 'attendance_latitude_invalid');
  await rejectsWithoutWrite(validInput({ attendanceLongitude: -181 }), 'attendance_longitude_invalid');
});

test('ignora radio y precisión enviados por el cliente y fuerza 100/50', async () => {
  const prisma = createPrisma();
  const result = await updateDispatchAttendancePointConfig(prisma, validInput({
    geofenceRadiusMeters: 2_000,
    maxLocationAccuracyMeters: 500
  }));
  assert.equal(result.geofenceRadiusMeters, 100);
  assert.equal(result.maxLocationAccuracyMeters, 50);
});

test('rechaza booleanos ambiguos', async () => {
  await rejectsWithoutWrite(validInput({ attendanceEnabled: 'yes' }), 'attendance_enabled_invalid');
  await rejectsWithoutWrite(validInput({ manualAttendanceAllowed: {} }), 'manual_attendance_allowed_invalid');
});

test('acepta booleanos explícitos típicos de formulario', async () => {
  const prisma = createPrisma(basePoint({
    attendanceLatitude: 4.7,
    attendanceLongitude: -74.1,
    geofenceRadiusMeters: 100,
    maxLocationAccuracyMeters: 50
  }));
  const result = await updateDispatchAttendancePointConfig(prisma, validInput({
    attendanceEnabled: 'on',
    manualAttendanceAllowed: '0'
  }));
  assert.equal(result.attendanceEnabled, true);
  assert.equal(result.manualAttendanceAllowed, false);
});

test('rechaza una política de fotografía o zona horaria no soportada', async () => {
  await rejectsWithoutWrite(validInput({ attendancePhotoPolicy: 'FACE_MATCH' }), 'attendance_photo_policy_not_allowed');
  await rejectsWithoutWrite(validInput({ attendanceTimezone: 'UTC' }), 'attendance_timezone_not_allowed');
});

test('rechaza activar un punto general inactivo', async () => {
  await rejectsWithoutWrite(validInput(), 'attendance_point_inactive', basePoint({ isActive: false }));
});

test('exige que el punto pertenezca al cliente indicado', async () => {
  await rejectsWithoutWrite(validInput({ clientId: 'client-other' }), 'attendance_operation_point_not_found');
});

test('desactivar conserva la configuración cuando los campos se omiten', async () => {
  const configured = basePoint({
    attendanceEnabled: true,
    attendanceLatitude: 4.711,
    attendanceLongitude: -74.0721,
    geofenceRadiusMeters: 100,
    maxLocationAccuracyMeters: 50,
    attendancePhotoPolicy: 'ALWAYS'
  });
  const prisma = createPrisma(configured);
  const result = await updateDispatchAttendancePointConfig(prisma, {
    clientId: configured.clientId,
    operationPointId: configured.id,
    attendanceEnabled: false
  });
  assert.equal(result.attendanceEnabled, false);
  assert.equal(result.attendanceLatitude, configured.attendanceLatitude);
  assert.equal(result.attendanceLongitude, configured.attendanceLongitude);
});

test('permite limpiar coordenadas al desactivar', async () => {
  const configured = basePoint({
    attendanceEnabled: true,
    attendanceLatitude: 4.711,
    attendanceLongitude: -74.0721,
    geofenceRadiusMeters: 100,
    maxLocationAccuracyMeters: 50
  });
  const prisma = createPrisma(configured);
  const result = await updateDispatchAttendancePointConfig(prisma, {
    clientId: configured.clientId,
    operationPointId: configured.id,
    attendanceEnabled: false,
    attendanceLatitude: '',
    attendanceLongitude: ''
  });
  assert.equal(result.attendanceLatitude, null);
  assert.equal(result.attendanceLongitude, null);
});

test('expone catálogos cerrados y estándares del producto', () => {
  assert.deepEqual(Object.values(ATTENDANCE_PHOTO_POLICY), ['NEVER', 'RISK_ONLY', 'ALWAYS']);
  assert.deepEqual(SUPPORTED_ATTENDANCE_TIMEZONES, ['America/Bogota']);
  assert.equal(DEFAULT_ATTENDANCE_GEOFENCE_RADIUS_METERS, 100);
  assert.equal(DEFAULT_ATTENDANCE_MAX_LOCATION_ACCURACY_METERS, 50);
});
