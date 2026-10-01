import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const eligibility = fs.readFileSync(new URL('../src/modules/dispatch-attendance/application/attendanceBillingEligibility.js', import.meta.url), 'utf8');
const counter = fs.readFileSync(new URL('../src/modules/dispatch-attendance/application/attendanceBillingCounter.js', import.meta.url), 'utf8');
const operationView = fs.readFileSync(new URL('../src/views/operacionesClienteOperaciones.ejs', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const devBilling = fs.readFileSync(new URL('../src/routes/cybionixBillingAdmin.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/workers/attendanceBillingInvoiceWorker.js', import.meta.url), 'utf8');

test('la facturabilidad se congela desde la hora exacta y no usa tolerancia de ausencia', () => {
  assert.match(eligibility, /now\.getTime\(\) < moment\.getTime\(\)/);
  assert.match(eligibility, /assignment\.status !== CONFIRMED_ASSIGNMENT_STATUS/);
  assert.match(eligibility, /attendanceEnabledAtService/);
  assert.match(eligibility, /ATTENDANCE_BILLING_ELIGIBILITY_LOCKED/);
  assert.doesNotMatch(eligibility, /absenceGraceMinutes/);
  assert.match(counter, /loadAttendanceBillingEligibilitySnapshots/);
  assert.match(counter, /SERVICE_START_LOCKED/);
});

test('la elegibilidad permanece auditable si se retira después del inicio', () => {
  assert.match(eligibility, /UNASSIGN_AFTER_SERVICE_START/);
  assert.match(eligibility, /NO_CONFIRMADO_AFTER_SERVICE_START/);
  assert.match(eligibility, /billingEligibilityPreserved:\s*true/);
  assert.match(server, /attendanceBillingMutationGuard\(prisma\)/);
  assert.match(devBilling, /Trazabilidad facturable de Asistencia/);
  assert.match(devBilling, /La elegibilidad facturable se conserva/);
});

test('el worker congela el ciclo vigente aunque el panel no esté abierto', () => {
  assert.match(worker, /DEFAULT_POLL_MS = 60 \* 1000/);
  assert.match(worker, /loadAttendanceBillingCounter\(prismaClient, \{ now \}\)/);
});

test('el check de Asistencia llega al primer render con el estado real, sin parpadeo por coordenadas', () => {
  assert.match(operationView, /name="attendanceEnabled" value="true" <%= op\.attendanceEnabled \? 'checked' : '' %>/);
  assert.doesNotMatch(operationView, /op\.attendanceEnabled \|\| op\.attendanceLatitude == null \|\| op\.attendanceLongitude == null/);
});

test('DEV tiene acceso visible a Facturación Cybionix desde la navegación', () => {
  assert.match(server, /admin-module-standalone-link/);
  assert.match(server, /href="\/admin\/cybionix-billing"/);
  assert.match(server, /Facturación Cybionix/);
});
