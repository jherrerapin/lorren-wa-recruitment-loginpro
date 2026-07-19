import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SCHEMA_PATH = new URL('../prisma/schema.prisma', import.meta.url);
const MIGRATION_PATH = new URL(
  '../prisma/migrations/20260719022000_add_dispatch_attendance_persistence/migration.sql',
  import.meta.url
);

async function readContracts() {
  const [schema, migration] = await Promise.all([
    readFile(SCHEMA_PATH, 'utf8'),
    readFile(MIGRATION_PATH, 'utf8')
  ]);

  return { schema, migration };
}

function modelBlock(schema, modelName) {
  const expression = new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`, 'm');
  const match = schema.match(expression);
  assert.ok(match, `Debe existir el modelo ${modelName}`);
  return match[1];
}

test('la asistencia queda desactivada por defecto en los puntos existentes', async () => {
  const { schema, migration } = await readContracts();
  const operationPoint = modelBlock(schema, 'DispatchOperationPoint');

  assert.match(operationPoint, /attendanceEnabled\s+Boolean\s+@default\(false\)/);
  assert.match(operationPoint, /attendanceLatitude\s+Decimal\?\s+@db\.Decimal\(10, 7\)/);
  assert.match(operationPoint, /attendanceLongitude\s+Decimal\?\s+@db\.Decimal\(10, 7\)/);
  assert.match(operationPoint, /attendanceTimezone\s+String\s+@default\("America\/Bogota"\)/);
  assert.match(migration, /"attendanceEnabled" BOOLEAN NOT NULL DEFAULT false/);
});

test('la sesión de asistencia es independiente y única por asignación', async () => {
  const { schema, migration } = await readContracts();
  const assignment = modelBlock(schema, 'DispatchAssignment');
  const session = modelBlock(schema, 'DispatchAttendanceSession');

  assert.match(assignment, /attendanceSession\s+DispatchAttendanceSession\?/);
  assert.match(session, /assignmentId\s+String\s+@unique/);
  assert.match(session, /assignment\s+DispatchAssignment\s+@relation\([^\n]*onDelete: Restrict\)/);
  assert.match(session, /attendanceStatus\s+String\s+@default\("PENDING"\)/);
  assert.match(session, /validationStatus\s+String\s+@default\("PENDING"\)/);
  assert.match(migration, /DispatchAttendanceSession_assignmentId_key/);
});

test('las marcaciones tienen idempotencia persistente y no guardan imágenes en PostgreSQL', async () => {
  const { schema, migration } = await readContracts();
  const mark = modelBlock(schema, 'DispatchAttendanceMark');

  assert.match(mark, /idempotencyKey\s+String\s+@unique/);
  assert.match(mark, /serverReceivedAt\s+DateTime\s+@default\(now\(\)\)/);
  assert.match(mark, /evidenceStorageKey\s+String\?/);
  assert.doesNotMatch(mark, /\bBytes\b/);
  assert.match(migration, /DispatchAttendanceMark_idempotencyKey_key/);
  assert.match(migration, /"evidenceStorageKey" TEXT/);
});

test('los dispositivos permiten detectar uso compartido sin imponer unicidad global', async () => {
  const { schema } = await readContracts();
  const worker = modelBlock(schema, 'DispatchWorker');
  const device = modelBlock(schema, 'DispatchWorkerDevice');

  assert.match(worker, /devices\s+DispatchWorkerDevice\[\]/);
  assert.match(device, /installationIdHash\s+String/);
  assert.match(device, /@@unique\(\[workerId, installationIdHash\]\)/);
  assert.doesNotMatch(device, /installationIdHash\s+String\s+@unique/);
  assert.match(device, /@@index\(\[installationIdHash, status\]\)/);
});

test('las revisiones conservan historial y relaciones restrictivas', async () => {
  const { schema, migration } = await readContracts();
  const review = modelBlock(schema, 'DispatchAttendanceReview');

  assert.match(review, /previousAttendanceStatus\s+String\?/);
  assert.match(review, /newAttendanceStatus\s+String\?/);
  assert.match(review, /reason\s+String/);
  assert.match(review, /actorUsername\s+String/);
  assert.match(review, /onDelete: Restrict/);
  assert.match(migration, /ON DELETE RESTRICT ON UPDATE CASCADE/);
});

test('la migración es expansiva y no contiene operaciones destructivas', async () => {
  const { migration } = await readContracts();
  const destructivePatterns = [
    /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bRENAME\s+(TO|COLUMN)\b/i,
    /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i
  ];

  for (const pattern of destructivePatterns) {
    assert.doesNotMatch(migration, pattern);
  }

  assert.match(migration, /CREATE TABLE "DispatchWorkerDevice"/);
  assert.match(migration, /CREATE TABLE "DispatchAttendanceSession"/);
  assert.match(migration, /CREATE TABLE "DispatchAttendanceMark"/);
  assert.match(migration, /CREATE TABLE "DispatchAttendanceReview"/);
});
