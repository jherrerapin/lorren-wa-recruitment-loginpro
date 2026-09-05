import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function functionBlock(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `No se encontró ${startMarker}`);
  assert.notEqual(end, -1, `No se encontró ${endMarker}`);
  return content.slice(start, end);
}

test('desactivar auxiliar libera solo compromisos no causados y conserva historia', () => {
  const route = source('src/routes/dispatchOpsExtras.js');
  const policySource = functionBlock(route, 'function todayIsoDate', 'function normalizeDateParam');
  const shouldRelease = new Function(
    'DEFAULT_ABSENCE_GRACE_MINUTES',
    `${policySource}; return shouldReleaseAssignmentOnWorkerDeactivation;`
  )(15);
  const now = new Date('2026-08-27T14:00:00.000Z'); // 09:00 en Bogotá.

  const assignment = (serviceDate, startTime, extra = {}) => ({
    serviceRequest: {
      serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
      startTime,
      operationPoint: { absenceGraceMinutes: 15 }
    },
    attendanceSession: null,
    ...extra
  });

  assert.equal(shouldRelease(assignment('2026-08-28', '08:00'), now), true, 'una asignación futura debe liberarse');
  assert.equal(shouldRelease(assignment('2026-08-27', '09:30'), now), true, 'una asignación de hoy que aún no inicia debe liberarse');
  assert.equal(shouldRelease(assignment('2026-08-27', '08:00'), now), false, 'una asignación cuyo margen de llegada ya pasó debe conservarse como historia');
  assert.equal(shouldRelease(assignment('2026-08-26', '10:00'), now), false, 'una asignación anterior debe conservarse');
  assert.equal(shouldRelease(assignment('2026-08-28', '08:00', { attendanceSession: { id: 'session-pseudonym' } }), now), false, 'una sesión de asistencia persistida nunca debe degradarse al desactivar');

  const deactivation = functionBlock(
    route,
    'async function cancelWorkerActiveAssignments',
    'export function dispatchOpsExtrasRouter'
  );
  assert.match(deactivation, /shouldReleaseAssignmentOnWorkerDeactivation/);
  assert.match(deactivation, /attendanceSession:\s*\{\s*select:\s*\{\s*id:\s*true/);
  assert.match(deactivation, /dispatchAssignment\.update/);
  assert.doesNotMatch(deactivation, /dispatchAssignment\.delete/);
});

test('personal separa activos de desactivados y conserva acceso a historial', () => {
  const route = source('src/routes/dispatchOpsExtras.js');
  const personnelView = source('src/views/operacionesPersonal.ejs');
  const personalRoute = functionBlock(route, "router.get('/personal'", "router.get('/personal/importar-excel'");

  assert.match(route, /DISABLED_OPERATIONAL_STATUSES = \['DISABLED', 'INACTIVE'\]/);
  assert.match(route, /function buildDispatchEligibilityFilter\(status\)/);
  assert.match(route, /operationalStatus:\s*\{\s*in:\s*DISABLED_OPERATIONAL_STATUSES\s*\}/);
  assert.match(personalRoute, /buildDispatchEligibilityFilter\(requestedStatus\)/);
  assert.match(personalRoute, /status:\s*inactiveView \? 'DISABLED' : 'CONTRATADO'/);

  assert.match(personnelView, /value="DISABLED"/);
  assert.match(personnelView, /Inactivos \/ desactivados/);
  assert.match(personnelView, />Estado<\/th>/);
  assert.match(personnelView, /workerActive \? 'Desactivar' : 'Reactivar'/);
  assert.match(personnelView, /\/personal\/<%= w\.id %>\/historial/);
  assert.match(personnelView, /registros históricos/);
});

test('nuevas asignaciones solo aceptan auxiliares CONTRATADO también en el POST', () => {
  const route = source('src/routes/dispatchOpsExtras.js');
  const assignmentBoard = functionBlock(route, "router.get('/asignaciones'", "router.get('/solicitudes'");
  const assignmentPost = functionBlock(route, "router.post('/asignaciones/assign'", "router.post('/asignaciones/descansos'");

  assert.match(assignmentBoard, /baseWorkerWhere = \{ operationalStatus: 'CONTRATADO'/);
  assert.match(assignmentPost, /dispatchWorker\.findFirst\(\{\s*where:\s*\{\s*id:\s*workerId,\s*operationalStatus:\s*'CONTRATADO'/);
  assert.match(assignmentPost, /no está activo y no puede recibir nuevas asignaciones/);
});

test('historial consulta todas las asignaciones aunque el auxiliar esté desactivado', () => {
  const statsRoute = source('src/routes/dispatchWorkerStats.js');
  const historyRoute = functionBlock(
    statsRoute,
    "router.get('/personal/:workerId/historial'",
    'return router;'
  );

  assert.match(historyRoute, /dispatchWorker\.findUnique/);
  assert.match(historyRoute, /dispatchAssignment\.findMany\(\{[\s\S]*where:\s*\{\s*workerId:\s*worker\.id\s*\}/);
  assert.doesNotMatch(historyRoute, /operationalStatus:\s*'CONTRATADO'/);
  assert.doesNotMatch(historyRoute, /status:\s*\{\s*in:\s*ACTIVE_ASSIGNMENT_STATUSES/);
});

test('Gestión de Tiempo conserva auxiliares desactivados y sus sesiones causadas', () => {
  const payroll = source('src/modules/dispatch-payroll/application/payrollReport.js');
  const report = functionBlock(
    payroll,
    'export async function loadPayrollReport',
    'export function buildPayrollExportRows'
  );

  assert.match(report, /dispatchAttendanceSession\.findMany/);
  assert.match(report, /operationalStatus:\s*\{\s*not:\s*'ELIMINADO'\s*\}/);
  assert.doesNotMatch(report, /operationalStatus:\s*'CONTRATADO'/);
  assert.match(report, /decoratePayrollRows\(report, workers, periodRests/);
});

test('el flujo ejecutado mantiene dispatchOpsExtras como autoridad de personal y asignaciones', () => {
  const server = source('src/server.js');
  assert.match(server, /dispatchOpsExtrasRouter\(prisma\)/);
  assert.doesNotMatch(server, /dispatchWorkerToggleAnySource/);
  assert.doesNotMatch(server, /dispatchWorkerExitReasons/);
  assert.doesNotMatch(server, /dispatchAssignmentConfirmationsRouter/);
});

test('la reparación histórica restaura solo degradaciones demostrables y recalcula cobertura', () => {
  const migration = source('prisma/migrations/20260827145000_repair_dispatch_deactivation_history/migration.sql');

  assert.match(migration, /assignment\."status" IN \('NO_CONFIRMO', 'CANCELLED'\)/);
  assert.match(migration, /Auxiliar desactivado desde el modulo de personal/);
  assert.match(migration, /Auxiliar desactivado desde el módulo de personal/);
  assert.match(migration, /Auxiliar retirado del flujo\. Causal/);
  assert.match(migration, /attendance\."id" IS NOT NULL/);
  assert.match(migration, /assignment\."status" = 'NO_CONFIRMO'/);
  assert.match(migration, /assignment\."updatedAt" >/);
  assert.match(migration, /COALESCE\(point\."absenceGraceMinutes", 15\)/);
  assert.match(migration, /SET "status" = 'CONFIRMED'/);

  assert.match(migration, /"AffectedRequests" AS/);
  assert.match(migration, /"OperationalCoverage" AS/);
  assert.match(migration, /assignment\."status" IN \('ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'\)/);
  assert.match(migration, /COALESCE\(worker\."isTestProfile", false\) = false/);
  assert.match(migration, /THEN 'ASSIGNMENT_COMPLETE'/);
  assert.match(migration, /THEN 'PENDING_CONFIRMATION'/);
  assert.match(migration, /THEN 'ASSIGNMENT_PARTIAL'/);
  assert.match(migration, /ELSE 'PENDING_ASSIGNMENT'/);

  assert.doesNotMatch(migration, /SET "status" = 'ASSIGNED'/);
  assert.doesNotMatch(migration, /SET "status" = 'CONFIRMATION_PENDING'/);
  assert.doesNotMatch(migration, /DELETE FROM "DispatchAssignment"/);
  assert.doesNotMatch(migration, /DELETE FROM "DispatchAttendanceSession"/);
});
