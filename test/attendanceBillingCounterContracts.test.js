import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const adminRoute = fs.readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
const runtimeLoader = fs.readFileSync(new URL('../src/public/attendance-admin-runtime.js', import.meta.url), 'utf8');
const counterUi = fs.readFileSync(new URL('../src/public/attendance-admin-billing-counter.js', import.meta.url), 'utf8');

test('el panel expone el contador del ciclo sin valores monetarios', () => {
  assert.match(adminRoute, /loadAttendanceBillingCounters/);
  assert.match(adminRoute, /router\.get\(['"]\/billing-counter['"]/);
  assert.match(counterUi, /auxiliares facturables/);
  assert.match(counterUi, /Contador del ciclo 8 → 7/);
  assert.doesNotMatch(counterUi, /\$\s*\d|precio|tarifa|COP|valor acumulado/i);
});

test('el runtime de asistencia carga la interfaz del contador', () => {
  assert.match(runtimeLoader, /attendance-admin-billing-counter\.js/);
  assert.match(counterUi, /\/admin\/operaciones\/asistencia\/billing-counter/);
  assert.match(counterUi, /Ciclo anterior/);
  assert.match(counterUi, /Ver auxiliares incluidos/);
});
