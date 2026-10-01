import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEV_ATTENDANCE_LOCATION_BYPASS_MARKER,
  assertAttendanceOperationGeofence,
  resolveAttendanceOperationGeofence
} from '../src/modules/dispatch-attendance/application/attendanceGeofenceResolver.js';

function operation(id, latitude, longitude, overrides = {}) {
  return {
    id,
    isActive: true,
    attendanceEnabled: true,
    attendanceLatitude: latitude,
    attendanceLongitude: longitude,
    geofenceRadiusMeters: 120,
    maxLocationAccuracyMeters: 50,
    crossOperationAttendanceAllowed: false,
    ...overrides
  };
}

function prismaWithOperations(operations = []) {
  const queries = [];
  return {
    queries,
    dispatchOperationPoint: {
      async findMany(query) {
        queries.push(query);
        return operations.map((item) => ({ ...item }));
      }
    }
  };
}

function prismaWithDevRequest({ role = 'DEV', source = 'INTERNAL' } = {}) {
  return {
    dispatchAssignment: {
      async findUnique() {
        return {
          serviceRequest: {
            id: 'request-dev',
            source,
            notes: `Prueba fuera de sede\n${DEV_ATTENDANCE_LOCATION_BYPASS_MARKER}`,
            createdByUsername: 'dev-user'
          }
        };
      }
    },
    appUser: {
      async findUnique() {
        return { role };
      }
    }
  };
}

const source = operation('operation-source', 1, 1);
const target = operation('operation-target', 1.01, 1.01);
const targetLocation = { latitude: 1.01, longitude: 1.01, accuracyMeters: 12 };

test('flag apagado conserva la geocerca exclusiva de la operación asignada', async () => {
  const prisma = prismaWithOperations([target]);
  const result = await resolveAttendanceOperationGeofence(prisma, source, targetLocation);

  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, 'attendance_outside_operation_range');
  assert.equal(prisma.queries.length, 0);
});

test('flag de la operación de origen habilita a todos sus auxiliares para una operación registrada', async () => {
  const prisma = prismaWithOperations([target]);
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    { ...source, crossOperationAttendanceAllowed: true },
    targetLocation
  );

  assert.equal(result.accepted, true);
  assert.equal(result.operationPointId, 'operation-target');
  assert.equal(result.crossOperation, true);
  assert.equal(prisma.queries.length, 1);
  assert.equal(prisma.queries[0].where.isActive, true);
  assert.equal(prisma.queries[0].where.attendanceEnabled, true);
  assert.deepEqual(prisma.queries[0].where.id, { not: 'operation-source' });
});

test('flag encendido no permite marcar fuera de todas las operaciones registradas', async () => {
  const prisma = prismaWithOperations([target]);
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    { ...source, crossOperationAttendanceAllowed: true },
    { latitude: 2, longitude: 2, accuracyMeters: 10 }
  );

  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, 'attendance_outside_operation_range');
  assert.throws(() => assertAttendanceOperationGeofence(result), /attendance_outside_operation_range/);
});

test('operaciones destino inactivas, sin asistencia o sin geocerca no conceden ubicación', async () => {
  const candidates = [
    operation('inactive', 1.01, 1.01, { isActive: false }),
    operation('attendance-off', 1.01, 1.01, { attendanceEnabled: false }),
    operation('no-geofence', 1.01, 1.01, { attendanceLatitude: null, attendanceLongitude: null })
  ];
  const prisma = prismaWithOperations(candidates);
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    { ...source, crossOperationAttendanceAllowed: true },
    targetLocation
  );

  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, 'attendance_outside_operation_range');
});

test('si varias geocercas destino se superponen se usa la operación válida más cercana', async () => {
  const farther = operation('farther', 1.009, 1.01, { geofenceRadiusMeters: 500 });
  const nearer = operation('nearer', 1.01, 1.01, { geofenceRadiusMeters: 500 });
  const prisma = prismaWithOperations([farther, nearer]);
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    { ...source, crossOperationAttendanceAllowed: true },
    targetLocation
  );

  assert.equal(result.accepted, true);
  assert.equal(result.operationPointId, 'nearer');
});

test('la operación asignada conserva prioridad aunque la precisión reportada sea degradada', async () => {
  const overlapping = operation('overlap', 1, 1, { maxLocationAccuracyMeters: 500 });
  const prisma = prismaWithOperations([overlapping]);
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    { ...source, crossOperationAttendanceAllowed: true, maxLocationAccuracyMeters: 50 },
    { latitude: 1, longitude: 1, accuracyMeters: 80 }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.operationPointId, 'operation-source');
  assert.equal(result.errorCode, null);
  assert.equal(result.accuracyMeters, 80);
  assert.equal(result.maxAccuracyMeters, 50);
  assert.equal(prisma.queries.length, 0);
});

test('DEV puede desactivar la validación geográfica solo para una solicitud marcada explícitamente', async () => {
  const prisma = prismaWithDevRequest();
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    source,
    { assignmentId: 'assignment-dev', latitude: 9, longitude: 9, accuracyMeters: 15 }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.errorCode, null);
  assert.equal(result.locationValidationBypassed, true);
  assert.equal(result.operationPointId, 'operation-source');
});

test('el marcador de bypass no funciona si la solicitud fue creada por un usuario que no es DEV', async () => {
  const prisma = prismaWithDevRequest({ role: 'ADMIN' });
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    source,
    { assignmentId: 'assignment-admin', latitude: 9, longitude: 9, accuracyMeters: 15 }
  );

  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, 'attendance_outside_operation_range');
  assert.equal(result.locationValidationBypassed, undefined);
});

test('solicitudes DEV_TEST aceptan el bypass porque su ruta de creación ya está restringida a DEV', async () => {
  const prisma = prismaWithDevRequest({ role: 'ADMIN', source: 'DEV_TEST' });
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    source,
    { assignmentId: 'assignment-dev-test', latitude: 9, longitude: 9, accuracyMeters: 15 }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.locationValidationBypassed, true);
});

test('la marcación grupal puede desactivar explícitamente la excepción entre operaciones', async () => {
  const prisma = prismaWithOperations([target]);
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    { ...source, crossOperationAttendanceAllowed: true },
    targetLocation,
    { allowCrossOperation: false }
  );

  assert.equal(result.accepted, false);
  assert.equal(result.errorCode, 'attendance_outside_operation_range');
  assert.equal(prisma.queries.length, 0);
});

test('llegada, almuerzo y salida comparten la misma autoridad y persisten la operación capturada', () => {
  for (const path of [
    'src/modules/dispatch-attendance/application/registerArrival.js',
    'src/modules/dispatch-attendance/application/registerBreak.js',
    'src/modules/dispatch-attendance/application/registerDeparture.js'
  ]) {
    const sourceCode = fs.readFileSync(path, 'utf8');
    assert.match(sourceCode, /resolveAttendanceOperationGeofence/);
    assert.match(sourceCode, /capturedOperationPointId:\s*geofence\.operationPointId/);
  }
});

test('el Portal usa la misma autoridad y mantiene cuadrillas restringidas a su operación Bluetooth', () => {
  const portal = fs.readFileSync('src/routes/workerPortal.js', 'utf8');
  assert.match(portal, /resolveAttendanceOperationGeofence/);
  assert.match(portal, /allowCrossOperation:\s*!requestedCrewGroup/);
  assert.match(portal, /allowCrossOperation:\s*false/);
  assert.match(portal, /Debes estar dentro del rango de una operación registrada para marcar asistencia/);
});

test('la creación de solicitudes muestra a DEV el control explícito de ubicación', () => {
  const view = fs.readFileSync('src/views/operacionesSolicitudes.ejs', 'utf8');
  assert.match(view, /id="requireAttendanceLocation"/);
  assert.match(view, /Validar ubicación al marcar asistencia/);
  assert.match(view, /DEV:ATTENDANCE_LOCATION_BYPASS/);
  assert.match(view, /role === 'dev'/);
});

test('Prisma y la migración conservan flag por operación y trazabilidad de la ubicación usada', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const migration = fs.readFileSync(
    'prisma/migrations/20260815040000_add_cross_operation_attendance/migration.sql',
    'utf8'
  );

  assert.match(schema, /crossOperationAttendanceAllowed\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /capturedOperationPointId\s+String\?/);
  assert.match(migration, /"crossOperationAttendanceAllowed"\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+false/i);
  assert.match(migration, /"capturedOperationPointId"\s+TEXT/i);
  assert.doesNotMatch(migration, /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
});
