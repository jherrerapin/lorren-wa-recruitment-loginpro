import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  confirmedOperationalAssignments,
  deriveDispatchRequestOperationalState,
  operationalAssignments
} from '../src/services/dispatchOperationalCoverage.js';

function source(path) {
  return fs.readFileSync(path, 'utf8');
}

test('perfil de pruebas no cuenta como asignado ni confirmado', () => {
  const request = {
    requiredWorkers: 1,
    assignments: [{ status: 'CONFIRMED', worker: { fullName: 'Jhon Herrera', isTestProfile: true } }]
  };
  assert.equal(operationalAssignments(request).length, 0);
  assert.equal(confirmedOperationalAssignments(request).length, 0);
  assert.deepEqual(deriveDispatchRequestOperationalState(request), {
    status: 'PENDING_ASSIGNMENT',
    activeCount: 0,
    confirmedCount: 0,
    requiredWorkers: 1
  });
});

test('una asignación sin auxiliar relacionado tampoco cuenta como cobertura', () => {
  const request = {
    requiredWorkers: 1,
    assignments: [{ status: 'CONFIRMED', worker: null }]
  };
  assert.equal(operationalAssignments(request).length, 0);
  assert.equal(deriveDispatchRequestOperationalState(request).status, 'PENDING_ASSIGNMENT');
});

test('auxiliar real sigue determinando pendiente o completa', () => {
  const pending = {
    requiredWorkers: 1,
    assignments: [
      { status: 'CONFIRMED', worker: { isTestProfile: true } },
      { status: 'CONFIRMATION_PENDING', worker: { isTestProfile: false } }
    ]
  };
  assert.equal(deriveDispatchRequestOperationalState(pending).status, 'PENDING_CONFIRMATION');
  pending.assignments[1].status = 'CONFIRMED';
  assert.equal(deriveDispatchRequestOperationalState(pending).status, 'ASSIGNMENT_COMPLETE');
});

test('migración marca Jhon Herrera y recalcula solicitudes afectadas', () => {
  const schema = source('prisma/schema.prisma');
  const migration = source('prisma/migrations/20260722180500_exclude_dispatch_test_worker/migration.sql');
  assert.match(schema, /isTestProfile\s+Boolean\s+@default\(false\)/);
  assert.match(migration, /jhon herrera/);
  assert.match(migration, /OperationalCoverage/);
  assert.match(migration, /COALESCE\(worker\."isTestProfile", false\) = false/);
});

test('autoasignación excluye perfiles de prueba y no les reserva cupos', () => {
  const auto = source('src/services/dispatchAutoAssignment.js');
  assert.match(auto, /worker\.isTestProfile/);
  assert.match(auto, /isTestProfile: false/);
  assert.match(auto, /operationalAssignments\(request\)\.length/);
});

test('reportes y tablero comparten la cobertura operativa', () => {
  const pdf = source('src/services/dispatchProgrammingPdfService.js');
  const dashboard = source('src/routes/dispatchDashboardMetrics.js');
  assert.match(pdf, /operationalAssignments/);
  assert.match(pdf, /effectiveRequestStatus/);
  assert.match(dashboard, /confirmedOperationalAssignments/);
  assert.match(dashboard, /deriveDispatchRequestOperationalState/);
});

test('todos los recalculadores principales usan la autoridad central', () => {
  for (const path of [
    'src/routes/dispatchOpsExtras.js',
    'src/services/dispatchWhatsappWebhookService.js',
    'src/services/dispatchWorkerDeactivationAnalytics.js',
    'src/services/dispatchWorkerToggleAnySource.js',
    'src/services/dispatchWorkerExitReasons.js'
  ]) {
    const content = source(path);
    assert.match(content, /recalculateDispatchServiceRequestStatus/);
    assert.doesNotMatch(content, /dispatchAssignment\.count\(\{ where: \{ serviceRequestId/);
  }
});
