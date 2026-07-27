import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8');
const view = fs.readFileSync(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
const departure = fs.readFileSync(new URL('../src/modules/dispatch-attendance/application/registerDeparture.js', import.meta.url), 'utf8');
const breakRegistration = fs.readFileSync(new URL('../src/modules/dispatch-attendance/application/registerBreak.js', import.meta.url), 'utf8');
const workPolicy = fs.readFileSync(new URL('../src/modules/dispatch-attendance/domain/attendanceWorkdayPolicy.js', import.meta.url), 'utf8');
const adminRoute = fs.readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
const adminView = fs.readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');
const evidence = fs.readFileSync(new URL('../src/services/attendanceEvidenceStorage.js', import.meta.url), 'utf8');

test('la salida usa una ruta protegida paralela a la llegada', () => {
  assert.match(route, /\/asignaciones\/:assignmentId\/salida/);
  assert.match(route, /registerDispatchDeparture/);
  assert.match(route, /loadWorkerPortalAssignmentForMark/);
  assert.match(route, /expectedWorkerId: portalSession\.workerId/);
  assert.match(route, /X-Requested-With|x-requested-with/);
});

test('el portal ofrece almuerzo opcional y salida después de la llegada', () => {
  assert.match(view, /BREAK_START/);
  assert.match(view, /BREAK_END/);
  assert.match(view, /Iniciar almuerzo/);
  assert.match(view, /Registrar salida/);
  assert.match(view, /departure_arrival_required/);
  assert.match(view, /Tiempo trabajado/);
  assert.match(view, /almuerzo solo se descuenta/i);
});

test('la evidencia separa llegada y salida', () => {
  assert.match(evidence, /MARK_PATHS/);
  assert.match(evidence, /ARRIVAL: 'arrival'/);
  assert.match(evidence, /DEPARTURE: 'departure'/);
  assert.match(evidence, /storeAttendanceDepartureEvidence/);
});

test('el almuerzo se registra como dos marcaciones auditables', () => {
  assert.match(route, /inicio-almuerzo/);
  assert.match(route, /fin-almuerzo/);
  assert.match(breakRegistration, /BREAK_START/);
  assert.match(breakRegistration, /BREAK_END/);
  assert.match(breakRegistration, /idempotencyKey/);
  assert.match(breakRegistration, /serverReceivedAt/);
});

test('la salida calcula tramos reales y bloquea un almuerzo abierto', () => {
  assert.match(departure, /attendance_departure_break_end_required/);
  assert.match(departure, /breakStartAt/);
  assert.match(departure, /breakEndAt/);
  assert.match(workPolicy, /unpaidBreakMinutesDeducted/);
  assert.match(workPolicy, /recognizeEarlyArrival/);
});

test('el panel muestra registro, almuerzo, tiempo anticipado y neto', () => {
  assert.doesNotMatch(adminRoute, /upsertDispatchAttendanceBreakPolicy/);
  assert.match(adminView, /Desde entrada hasta salida/);
  assert.match(adminView, /Tiempo anticipado excluido/);
  assert.match(adminView, /Almuerzo descontado/);
  assert.match(adminView, /Tiempo neto trabajado/);
  assert.match(adminView, /Reconocer tiempo anterior al turno/);
});
