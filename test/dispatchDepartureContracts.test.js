import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../src/routes/workerPortalCore.js', import.meta.url), 'utf8');
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


test('el núcleo conserva almuerzo opcional, salida y cálculo de jornada', () => {
  assert.match(view, /BREAK_START/);
  assert.match(view, /BREAK_END/);
  assert.match(view, /Iniciar almuerzo/);
  assert.match(view, /Registrar salida/);
  assert.match(view, /departure_arrival_required/);
  assert.match(view, /Tiempo trabajado/);
  assert.match(view, /jornada ordinaria es de 7 horas/i);
  assert.match(view, /Horas extra/);
  assert.match(view, /1 hora y 30 minutos/);
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


test('la salida calcula tramos reales y penaliza un almuerzo abierto sin bloquear', () => {
  assert.doesNotMatch(departure, /attendance_departure_break_end_required/);
  assert.match(departure, /breakStartAt/);
  assert.match(departure, /breakEndAt/);
  assert.match(workPolicy, /INCOMPLETE_DISPATCH_BREAK_PENALTY_MINUTES\s*=\s*90/);
  assert.match(workPolicy, /STANDARD_DISPATCH_WORKDAY_MINUTES\s*=\s*7\s*\*\s*60/);
  assert.match(workPolicy, /shortBreakMinutesCredited/);
  assert.match(workPolicy, /overtimeMinutes/);
  assert.match(workPolicy, /recognizeEarlyArrival/);
});


test('el cálculo administrativo se conserva aunque la capa compacta lo oculte', () => {
  assert.doesNotMatch(adminRoute, /upsertDispatchAttendanceBreakPolicy/);
  assert.match(adminView, /Entrada a salida/);
  assert.match(adminView, /Anticipado excluido/);
  assert.match(adminView, /Almuerzo descontado/);
  assert.match(adminView, /Horas ordinarias/);
  assert.match(adminView, /Horas extra/);
  assert.match(adminView, /Total trabajado/);
  assert.match(adminView, /Reconocer tiempo anterior al turno/);
});
