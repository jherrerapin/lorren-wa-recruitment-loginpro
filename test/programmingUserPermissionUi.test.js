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

test('el contacto DEV aparece solo en la lista DEV y los demás perfiles reciben únicamente destinatarios generales', () => {
  const recipients = [
    { name: 'Destinatario general', phone: '0000000001', devOnly: false },
    { name: 'Duplicado del DEV', phone: '0000000002', devOnly: false },
    { name: 'Privado legado', phone: '0000000003', devOnly: true }
  ];
  const devContact = { email: 'dev@example.test', phone: '0000000002' };

  const forDev = filterProgrammingWhatsappRecipientsForRole(recipients, 'dev', devContact);
  const forAdmin = filterProgrammingWhatsappRecipientsForRole(recipients, 'admin', devContact);

  assert.deepEqual(forAdmin.map((item) => item.name), ['Destinatario general']);
  assert.deepEqual(forDev.map((item) => item.name), ['Destinatario general', 'DEV']);
  assert.equal(forDev[1].isDevContact, true);
  assert.equal(forDev[1].checkedByDefault, false);
  assert.equal(forDev[1].email, 'dev@example.test');
});
