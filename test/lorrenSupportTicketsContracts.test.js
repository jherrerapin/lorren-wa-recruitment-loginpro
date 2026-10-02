import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const webhook = fs.readFileSync('src/routes/lorrenWhatsappWebhook.js', 'utf8');
const tickets = fs.readFileSync('src/services/lorrenSupportTickets.js', 'utf8');
const admin = fs.readFileSync('src/routes/lorrenSupportTicketsAdmin.js', 'utf8');
const server = fs.readFileSync('src/server.js', 'utf8');
const whatsappClient = fs.readFileSync('src/services/lorrenWhatsappClient.js', 'utf8');

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

test('solo supervisor de facturación y teléfonos DEV activos pueden originar tickets', () => {
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

test('DEV administra estados, prioridades, teléfonos y creación manual', () => {
  assert.match(admin, /Aprobar para desarrollo/);
  assert.match(admin, /Números autorizados para crear tickets/);
  assert.match(admin, /Crear ticket manual DEV/);
  assert.match(admin, /requireDev/);
  assert.match(admin, /LORREN_SUPPORT_STATUSES/);
  assert.match(admin, /LORREN_SUPPORT_PRIORITIES/);
});

test('aprobar desarrollo no implica merge ni deploy automático', () => {
  assert.match(admin, /No se hizo merge ni deploy automático/);
  assert.doesNotMatch(tickets, /git(hub)?\.com\/.*merge/i);
  assert.doesNotMatch(tickets, /repository_dispatch|workflow_dispatch/);
});

test('el panel de tickets está montado y visible para DEV o Supervisor', () => {
  assert.match(server, /lorrenSupportTicketsAdminRouter/);
  assert.match(server, /\/admin\/lorren-tickets/);
  assert.match(server, /currentRole === 'dev' \|\| currentOperationalRole === 'SUPERVISOR'/);
  assert.match(admin, /operationalRole\(req\) === 'SUPERVISOR'/);
});
