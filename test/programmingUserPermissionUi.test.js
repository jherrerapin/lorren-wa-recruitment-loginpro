import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';
import { filterProgrammingWhatsappRecipientsForRole } from '../src/routes/dispatchProgrammingNotifications.js';

const baseHtml = '<!DOCTYPE html><html><head><title>Usuarios</title></head><body><nav class="navbar"><a href="/admin">Panel</a><a href="/admin/users">Usuarios</a></nav><main>Contenido</main></body></html>';

function req(path, role = 'dev') {
  return { originalUrl: path, userRole: role, session: { userRole: role } };
}

test('Usuarios carga el controlador de Programación y otros paneles no lo cargan', () => {
  const usersHtml = injectAdminModuleNavigation(baseHtml, req('/admin/users'));
  const operationsHtml = injectAdminModuleNavigation(baseHtml, req('/admin/operaciones'));

  assert.match(usersHtml, /<script src="\/public\/users-programming-access\.js" defer><\/script>/);
  assert.doesNotMatch(operationsHtml, /users-programming-access\.js/);
});

test('Programación deja de renderizar el selector global y se administra por formulario de usuario', async () => {
  const [programmingUi, usersUi] = await Promise.all([
    readFile(new URL('../src/public/dispatch-programming-contacts.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/users-programming-access.js', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(programmingUi, /Mostrar Programación a:|renderProgrammingUserAccess|programmingUserAccess/);
  assert.match(usersUi, /Programación del día/);
  assert.match(usersUi, /form\[action\^="\/admin\/locations\/users\/"\]\[action\$="\/access"\]/);
  assert.match(usersUi, /input\[name="canAccessDispatch"\]/);
  assert.match(usersUi, /\/admin\/operaciones\/programacion\/acceso/);
});

test('el endpoint DEV enumera usuarios ADMIN sin limitarse a Operaciones o Asistencia', async () => {
  const routeSource = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  const accessRoute = routeSource.match(/router\.get\('\/programacion\/acceso'[\s\S]*?router\.post\('\/programacion\/acceso'/)?.[0] || '';

  assert.match(accessRoute, /where:\s*\{\s*role:\s*'ADMIN'\s*\}/);
  assert.doesNotMatch(accessRoute, /OR:\s*\[\{ canAccessDispatch|isActive:\s*true/);
  assert.match(accessRoute, /enabled:\s*settings\.userAccess\.includes\(user\.username\)/);
});

test('un destinatario Solo DEV queda completamente fuera de perfiles no DEV', () => {
  const recipients = [
    { name: 'Destinatario general', phone: '573001112233', devOnly: false },
    { name: 'Destinatario privado', phone: '573004445566', devOnly: true }
  ];

  const forDev = filterProgrammingWhatsappRecipientsForRole(recipients, 'dev');
  const forAdmin = filterProgrammingWhatsappRecipientsForRole(recipients, 'admin');

  assert.equal(forDev.length, 2);
  assert.deepEqual(forAdmin, [{ name: 'Destinatario general', phone: '573001112233', devOnly: false }]);
});