import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
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

test('la operación asignada conserva prioridad y su precisión no se evade con una geocerca solapada', async () => {
  const overlapping = operation('overlap', 1, 1, { maxLocationAccuracyMeters: 500 });
  const prisma = prismaWithOperations([overlapping]);
  const result = await resolveAttendanceOperationGeofence(
    prisma,
    { ...source, crossOperationAttendanceAllowed: true, maxLocationAccuracyMeters: 50 },
    { latitude: 1, longitude: 1, accuracyMeters: 80 }
  );

  assert.equal(result.accepted, false);
  assert.equal(result.operationPointId, 'operation-source');
  assert.equal(result.errorCode, 'attendance_location_accuracy_insufficient');
  assert.equal(prisma.queries.length, 0);
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
