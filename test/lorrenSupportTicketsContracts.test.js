import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const webhook = fs.readFileSync('src/routes/lorrenWhatsappWebhook.js', 'utf8');
const tickets = fs.readFileSync('src/services/lorrenSupportTickets.js', 'utf8');
const admin = fs.readFileSync('src/routes/lorrenSupportTicketsAdmin.js', 'utf8');
const server = fs.readFileSync('src/server.js', 'utf8');
const navigation = fs.readFileSync('src/services/adminNavigation.js', 'utf8');
const operationalAccess = fs.readFileSync('src/services/operationalAccess.js', 'utf8');
const userAccess = fs.readFileSync('src/public/payroll-user-access.js', 'utf8');
const whatsappClient = fs.readFileSync('src/services/lorrenWhatsappClient.js', 'utf8');
const developmentDispatch = fs.readFileSync('src/services/lorrenSupportDevelopmentDispatch.js', 'utf8');
const developmentWorkflow = fs.readFileSync('.github/workflows/lorren-support-ticket-development.yml', 'utf8');

test('los tickets de WhatsApp son silenciosos y no invocan autoridades outbound', () => {
  assert.match(webhook, /createLorrenSupportTicketFromWhatsapp/);
  assert.match(webhook, /handleSilentSupportTicket/);
  assert.doesNotMatch(webhook, /sendLorrenWhatsapp/i);
  assert.doesNotMatch(webhook, /send.*Support.*Message/i);
  assert.doesNotMatch(webhook, /reply.*text/i);
});

test('el webhook conserva la autoridad de aprobación de facturación', () => {
  assert.match(webhook, /DECISION_PATTERN/);
  assert.match(webhook, /resolveLorrenAttendanceApproval/);
  assert.match(whatsappClient, /lorren_billing:approve:/);
  assert.match(whatsappClient, /lorren_billing:reject:/);
});

test('solo supervisor de facturación y teléfonos DEV activos pueden originar tickets por WhatsApp', () => {
  assert.match(tickets, /loadLorrenBillingConfig/);
  assert.match(tickets, /billing\?\.supervisor\?\.phone/);
  assert.match(tickets, /config\.authorizedPhones/);
  assert.match(tickets, /if \(!item\.active\) continue/);
  assert.match(tickets, /unauthorized_phone/);
});

test('el texto original se conserva separado de la interpretación IA', () => {
  assert.match(tickets, /originalText,/);
  assert.match(tickets, /interpretation,/);
  assert.match(admin, /Mensaje original/);
  assert.match(admin, /Interpretación IA/);
});

test('la recepción de WhatsApp es idempotente por message id', () => {
  assert.match(tickets, /INBOUND_ENTITY_TYPE/);
  assert.match(tickets, /entityId: messageId/);
  assert.match(tickets, /duplicate: true/);
});

test('Tickets es un acceso independiente gobernado por permiso explícito', () => {
  assert.match(operationalAccess, /SUPPORT_TICKETS_ACCESS:\s*'SUPPORT_TICKETS_ACCESS'/);
  assert.match(operationalAccess, /module:\s*'Tickets',\s*label:\s*'Acceder al módulo y crear tickets'/);
  assert.match(operationalAccess, /normalizedCapability === OPERATIONAL_CAPABILITY\.SUPPORT_TICKETS_ACCESS \? false : true/);
  assert.match(userAccess, /if \(!root\) \{/);
  assert.match(userAccess, /legend\.textContent = moduleName/);
  assert.match(navigation, /standaloneTicketsLink/);
  assert.match(navigation, /data-standalone-link="lorren-tickets"/);
  assert.doesNotMatch(navigation.match(/function recruitmentMenuItems[\s\S]*?function operationsMenuItems/)?.[0] || '', /lorren-tickets/);
  assert.doesNotMatch(server, /currentOperationalRole === 'SUPERVISOR'[\s\S]*lorren-tickets/);
  assert.match(admin, /hasOperationalCapability\(req, OPERATIONAL_CAPABILITY\.SUPPORT_TICKETS_ACCESS\)/);
});

test('usuario autorizado puede crear desde el módulo; administración sensible sigue siendo DEV', () => {
  assert.match(admin, /router\.post\('\/create', form,/);
  assert.doesNotMatch(admin, /router\.post\('\/create', requireDev/);
  assert.match(admin, /source: isDev\(req\) \? 'DEV_PANEL' : 'USER_PANEL'/);
  assert.match(admin, /router\.post\('\/:ticketId\/update', requireDev/);
  assert.match(admin, /router\.post\('\/:ticketId\/approve-development', requireDev/);
  assert.match(admin, /Números autorizados para crear tickets/);
});

test('solo DEV elimina tickets y la eliminación conserva auditoría como tombstone', () => {
  assert.match(admin, /router\.post\('\/:ticketId\/delete', requireDev/);
  assert.match(admin, /confirmDelete !== '1'/);
  assert.match(admin, /deleteLorrenSupportTicket/);
  assert.match(tickets, /LORREN_SUPPORT_TICKET_DELETED/);
  assert.match(tickets, /fromValue: previous/);
  assert.match(tickets, /toValue: tombstone/);
  assert.match(tickets, /if \(!row \|\| row\.action === TICKET_DELETED\) return null/);
});

test('aprobar desarrollo no implica merge ni deploy automático', () => {
  assert.match(admin, /dispatchLorrenSupportDevelopment/);
  assert.match(developmentDispatch, /repository_dispatch|\/dispatches/);
  assert.match(developmentWorkflow, /--draft/);
  assert.doesNotMatch(developmentWorkflow, /gh\s+pr\s+merge/i);
  assert.doesNotMatch(developmentWorkflow, /railway\s+up/i);
  assert.doesNotMatch(developmentWorkflow, /kubectl\s+apply|docker\s+push/i);
});

test('el panel de tickets continúa montado sin autoridad paralela por rol Supervisor', () => {
  assert.match(server, /lorrenSupportTicketsAdminRouter/);
  assert.match(server, /\/admin\/lorren-tickets/);
  assert.doesNotMatch(admin, /operationalRole\(req\) === 'SUPERVISOR'/);
});

test('Tickets conserva header canónico, icono propio y color tenue por estado', () => {
  assert.match(navigation, /TICKETS_ICON/);
  assert.match(navigation, /standaloneIcon\(TICKETS_ICON\)/);
  assert.match(admin, /buildAdminModuleNavbar/);
  assert.match(admin, /navbar: buildAdminModuleNavbar\(req\)/);
  assert.match(admin, /admin-module-navigation\.css/);
  assert.match(admin, /status-received/);
  assert.match(admin, /status-review/);
  assert.match(admin, /status-approved/);
  assert.match(admin, /status-progress/);
  assert.match(admin, /status-validation/);
  assert.match(admin, /status-done/);
  assert.match(admin, /status-rejected/);
  assert.match(admin, /status-cancelled/);
  assert.match(admin, /data-ticket-status/);
});
