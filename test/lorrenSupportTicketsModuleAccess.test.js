import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Tickets usa permiso persistente del catálogo operacional y no un flag de sesión huérfano', () => {
  const access = read('src/services/operationalAccess.js');
  const route = read('src/routes/lorrenSupportTicketsAdmin.js');
  assert.match(access, /TICKETS:\s*['"]tickets['"]/);
  assert.match(access, /SUPPORT_TICKETS_VIEW/);
  assert.match(route, /hasOperationalCapability/);
  assert.match(route, /SUPPORT_TICKETS_VIEW/);
});

test('Tickets es navegación independiente y no una opción dentro de Reclutamiento', () => {
  const navigation = read('src/services/adminNavigation.js');
  const recruitmentBody = navigation.match(/function recruitmentMenuItems[\s\S]*?function operationsMenuItems/)?.[0] || '';
  assert.doesNotMatch(recruitmentBody, /lorren-tickets/);
  assert.match(navigation, /data-standalone-link=["'](?:support-)?tickets["']/);
  assert.match(navigation, /href=["']\/admin\/lorren-tickets["']/);
});

test('editor unificado de permisos transporta el módulo tickets', () => {
  const client = read('src/public/payroll-user-access.js');
  assert.match(client, /tickets:\s*(?:value\.tickets === true|false)/);
  assert.match(client, /data-operational-module-access/);
});

test('usuarios autorizados pueden crear y solo DEV puede eliminar tickets', () => {
  const route = read('src/routes/lorrenSupportTicketsAdmin.js');
  const service = read('src/services/lorrenSupportTickets.js');
  assert.match(route, /router\.post\(['"]\/create['"]/);
  assert.doesNotMatch(route, /router\.post\(['"]\/create['"],\s*requireDev/);
  assert.match(route, /router\.post\(['"]\/:ticketId\/delete['"],\s*requireDev/);
  assert.match(route, /deleteLorrenSupportTicket/);
  assert.match(service, /LORREN_SUPPORT_TICKET_DELETED/);
  assert.match(service, /export async function deleteLorrenSupportTicket/);
});
