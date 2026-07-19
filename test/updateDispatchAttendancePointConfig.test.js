import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_PHOTO_POLICY,
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
    earlyArrivalWindowMinutes: 60,
    lateToleranceMinutes: 10,
    absenceGraceMinutes: 15,
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
    geofenceRadiusMeters: 120,
    maxLocationAccuracyMeters: 40,
    earlyArrivalWindowMinutes: 60,
    lateToleranceMinutes: 10,
    absenceGraceMinutes: 20,
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

test('activa un punto con geocerca completa y solo actualiza campos de asistencia', async () => {
  const prisma = createPrisma();
  const result = await updateDispatchAttendancePointConfig(prisma, validInput());

  assert.equal(result.attendanceEnabled, true);
  assert.equal(prisma.writes.length, 1);
  assert.deepEqual(Object.keys(prisma.writes[0].data).sort(), [
    'absenceGraceMinutes',
    'attendanceEnabled',
    'attendanceLatitude',
    'attendanceLongitude',
    'attendancePhotoPolicy',
    'attendanceTimezone',
    'earlyArrivalWindowMinutes',
    'geofenceRadiusMeters',
    'lateToleranceMinutes',
    'manualAttendanceAllowed',
    'maxLocationAccuracyMeters'
  ]);
  assert.equal(Object.hasOwn(prisma.writes[0].data, 'name'), false);
  assert.equal(Object.hasOwn(prisma.writes[0].data, 'address'), false);
  assert.equal(Object.hasOwn(prisma.writes[0].data, 'isActive'), false);
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

test('rechaza radio y precisión fuera de límites', async () => {
  await rejectsWithoutWrite(validInput({ geofenceRadiusMeters: 19 }), 'geofence_radius_meters_invalid');
  await rejectsWithoutWrite(validInput({ maxLocationAccuracyMeters: 501 }), 'max_location_accuracy_meters_invalid');
});

test('rechaza precisión mayor que el radio', async () => {
  await rejectsWithoutWrite(
    validInput({ geofenceRadiusMeters: 50, maxLocationAccuracyMeters: 80 }),
    'location_accuracy_exceeds_geofence_radius'
  );
});

test('rechaza declarar ausencia antes de la tolerancia de tardanza', async () => {
  await rejectsWithoutWrite(
    validInput({ lateToleranceMinutes: 20, absenceGraceMinutes: 10 }),
    'absence_grace_before_late_tolerance'
  );
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
    maxLocationAccuracyMeters: 30
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
    geofenceRadiusMeters: 120,
    maxLocationAccuracyMeters: 40,
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
  assert.equal(result.geofenceRadiusMeters, configured.geofenceRadiusMeters);
});

test('permite limpiar geocerca únicamente cuando la asistencia queda desactivada', async () => {
  const configured = basePoint({
    attendanceEnabled: true,
    attendanceLatitude: 4.711,
    attendanceLongitude: -74.0721,
    geofenceRadiusMeters: 120,
    maxLocationAccuracyMeters: 40
  });
  const prisma = createPrisma(configured);
  const result = await updateDispatchAttendancePointConfig(prisma, {
    clientId: configured.clientId,
    operationPointId: configured.id,
    attendanceEnabled: false,
    attendanceLatitude: '',
    attendanceLongitude: '',
    geofenceRadiusMeters: '',
    maxLocationAccuracyMeters: ''
  });

  assert.equal(result.attendanceLatitude, null);
  assert.equal(result.attendanceLongitude, null);
  assert.equal(result.geofenceRadiusMeters, null);
  assert.equal(result.maxLocationAccuracyMeters, null);
});

test('expone catálogos cerrados para la futura interfaz', () => {
  assert.deepEqual(Object.values(ATTENDANCE_PHOTO_POLICY), ['NEVER', 'RISK_ONLY', 'ALWAYS']);
  assert.deepEqual(SUPPORTED_ATTENDANCE_TIMEZONES, ['America/Bogota']);
});
