import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8');
const view = fs.readFileSync(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
const adminRoute = fs.readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
const adminView = fs.readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../prisma/migrations/20260725033000_add_dispatch_attendance_break_policy/migration.sql', import.meta.url), 'utf8');
const evidence = fs.readFileSync(new URL('../src/services/attendanceEvidenceStorage.js', import.meta.url), 'utf8');

test('la salida usa una ruta protegida paralela a la llegada', () => {
  assert.match(route, /\/asignaciones\/:assignmentId\/salida/);
  assert.match(route, /registerDispatchDeparture/);
  assert.match(route, /loadWorkerPortalAssignmentForMark/);
  assert.match(route, /expectedWorkerId: session\.workerId/);
  assert.match(route, /X-Requested-With|x-requested-with/);
});

test('el portal solo ofrece salida después de llegada', () => {
  assert.match(view, /data-mark-type="<%= assignment\.actionType %>"/);
  assert.match(view, /Registrar salida/);
  assert.match(view, /departure_arrival_required/);
  assert.match(view, /Tiempo neto/);
  assert.match(view, /Descanso/);
});

test('la evidencia separa llegada y salida', () => {
  assert.match(evidence, /MARK_PATHS/);
  assert.match(evidence, /ARRIVAL: 'arrival'/);
  assert.match(evidence, /DEPARTURE: 'departure'/);
  assert.match(evidence, /storeAttendanceDepartureEvidence/);
});

test('la política de descanso es deny-by-default y valida sus límites', () => {
  assert.match(migration, /policy" TEXT NOT NULL DEFAULT 'NONE'/);
  assert.match(migration, /unpaidBreakMinutes" INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /'FLEXIBLE'/);
  assert.match(migration, /BETWEEN 1 AND 240/);
  assert.match(migration, /ON DELETE CASCADE/);
});

test('el panel permite configurar descanso y muestra bruto, descuento y neto', () => {
  assert.match(adminRoute, /service-requests\/:serviceRequestId\/break-policy/);
  assert.match(adminRoute, /upsertDispatchAttendanceBreakPolicy/);
  assert.match(adminView, /Tiempo bruto/);
  assert.match(adminView, /Descanso descontado/);
  assert.match(adminView, /Tiempo neto pagable/);
  assert.match(adminView, /Descanso flexible no remunerado/);
  assert.match(adminView, /No requiere marcar inicio y regreso del almuerzo/);
});

test('el panel aclara que no liquida recargos legales', () => {
  assert.match(adminView, /recargos legales se liquidan con las reglas de nómina/);
  assert.doesNotMatch(adminView, /horas extra automáticas/);
});
