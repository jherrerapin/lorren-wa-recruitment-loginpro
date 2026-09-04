import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const middleware = readFileSync(
  new URL('../src/services/dispatchAuditMiddleware.js', import.meta.url),
  'utf8'
);
const userAccessUi = readFileSync(
  new URL('../src/public/payroll-user-access.js', import.meta.url),
  'utf8'
);

test('Supervisor recibe el panel de funciones en cualquier vista administrativa de Operaciones', () => {
  assert.match(
    middleware,
    /const supervisorPageAllowed = path\.startsWith\('\/admin\/operaciones'\) && canSupervise;/
  );
  assert.match(middleware, /data-can-supervise-operational-permissions=/);
  assert.match(userAccessUi, /Supervisión de funciones/);
  assert.match(userAccessUi, /Administrar permisos del equipo/);
});

test('Supervisor solo delega funciones y no recibe autoridad para cambiar roles', () => {
  const editorStart = userAccessUi.indexOf('function supervisorUserEditor');
  const editorEnd = userAccessUi.indexOf('async function initializeSupervisorPanel');
  assert.ok(editorStart >= 0 && editorEnd > editorStart, 'Debe existir el editor canónico del Supervisor.');

  const editor = userAccessUi.slice(editorStart, editorEnd);
  assert.match(editor, /JSON\.stringify\(\{ permissions:/);
  assert.doesNotMatch(editor, /roleSelect|data-operational-role|delegablePermissions/);
  assert.match(userAccessUi, /Los roles siguen siendo exclusivos de DEV\./);
});
