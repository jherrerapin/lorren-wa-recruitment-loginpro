import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  attendancePointConfigurationErrorMessage,
  dispatchAttendancePointConfigRouter,
  explicitAttendanceCheckbox
} from '../src/routes/dispatchAttendancePointConfig.js';

test('checkbox marcado requiere fallback false y valor true', () => {
  assert.equal(explicitAttendanceCheckbox({ enabledFallback: 'false', enabled: 'true' }, 'enabled'), 'true');
});

test('checkbox desmarcado produce false explícito', () => {
  assert.equal(explicitAttendanceCheckbox({ enabledFallback: 'false' }, 'enabled'), 'false');
});

test('checkbox rechaza valores permisivos o fallback ausente', () => {
  assert.throws(() => explicitAttendanceCheckbox({ enabled: 'on' }, 'enabled'), /enabled_fallback_invalid/);
  assert.throws(() => explicitAttendanceCheckbox({ enabledFallback: 'false', enabled: 'on' }, 'enabled'), /enabled_invalid/);
});

test('errores conocidos se traducen sin exponer códigos internos', () => {
  assert.equal(
    attendancePointConfigurationErrorMessage(new Error('attendance_geofence_coordinates_required')),
    'Ingresa latitud y longitud antes de habilitar la asistencia.'
  );
  assert.equal(
    attendancePointConfigurationErrorMessage(new Error('attendanceLatitude_invalid')),
    'Revisa los valores de asistencia e intenta nuevamente.'
  );
});

test('error desconocido devuelve mensaje genérico', () => {
  assert.equal(
    attendancePointConfigurationErrorMessage(new Error('database_detail_should_not_leak')),
    'No fue posible guardar la configuración de asistencia.'
  );
});

test('router conserva parámetros del padre', () => {
  const router = dispatchAttendancePointConfigRouter({});
  assert.equal(router.mergeParams, true);
});

test('router delega en la autoridad y no escribe Prisma directamente', () => {
  const source = fs.readFileSync('src/routes/dispatchAttendancePointConfig.js', 'utf8');
  assert.match(source, /updateDispatchAttendancePointConfig\(prisma,/);
  assert.doesNotMatch(source, /dispatchOperationPoint\.(update|create|upsert)/);
  assert.match(source, /express\.Router\(\{ mergeParams: true \}\)/);
  assert.match(source, /router\.post\('\/'/);
});

test('router no expone todavía una marcación pública', () => {
  const source = fs.readFileSync('src/routes/dispatchAttendancePointConfig.js', 'utf8');
  assert.doesNotMatch(source, /registerDispatchArrival/);
  assert.doesNotMatch(source, /\/public|\/marcar|\/llegada/);
});
