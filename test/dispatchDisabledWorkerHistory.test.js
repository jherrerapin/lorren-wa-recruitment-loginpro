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

test('desactivar auxiliar conserva filas de asignación y solo libera cobertura activa', () => {
  const route = source('src/routes/dispatchOpsExtras.js');
  const deactivation = functionBlock(
    route,
    'async function cancelWorkerActiveAssignments',
    'export function dispatchOpsExtrasRouter'
  );

  assert.match(deactivation, /dispatchAssignment\.findMany/);
  assert.match(deactivation, /dispatchAssignment\.update/);
  assert.match(deactivation, /status:\s*a\.status === CONFIRMED_ASSIGNMENT_STATUS \? 'NO_CONFIRMO' : 'CANCELLED'/);
  assert.doesNotMatch(deactivation, /dispatchAssignment\.delete/);
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

test('la interfaz avisa el estado desactivado y mantiene acceso a los registros históricos', () => {
  const historyView = source('src/views/operacionesPersonalHistorial.ejs');
  const personnelView = source('src/views/operacionesPersonal.ejs');
  const assignmentView = source('src/views/operacionesAsignacionesConfirmacion.ejs');

  assert.match(historyView, /workerIsActive = worker\.operationalStatus === 'CONTRATADO'/);
  assert.match(historyView, /DISABLED: 'Desactivado'/);
  assert.match(historyView, /No está disponible para nuevas asignaciones/);
  assert.match(historyView, /registros históricos de asignación se conservan/);
  assert.match(historyView, /incluso cuando el auxiliar ya está desactivado/);

  assert.match(personnelView, /value="DISABLED"/);
  assert.match(personnelView, /\/personal\/<%= w\.id %>\/historial/);
  assert.match(personnelView, /isActive \? 'Activo' : 'Desactivado'/);

  assert.match(assignmentView, /selectedServiceRequest\.assignments\.forEach/);
  assert.match(assignmentView, /NO_CONFIRMO:'No confirmó'/);
  assert.match(assignmentView, /CANCELLED:'Cancelado'/);
});

test('el flujo ejecutado mantiene dispatchOpsExtras como ruta montada de personal operativo', () => {
  const server = source('src/server.js');
  assert.match(server, /dispatchOpsExtrasRouter\(prisma\)/);
  assert.doesNotMatch(server, /dispatchWorkerToggleAnySource/);
  assert.doesNotMatch(server, /dispatchWorkerExitReasons/);
});
