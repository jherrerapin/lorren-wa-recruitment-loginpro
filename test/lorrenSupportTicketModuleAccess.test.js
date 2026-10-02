import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildAdminModuleNavbar } from '../src/services/adminNavigation.js';
import {
  canUseLorrenSupportTickets,
  loadLorrenSupportTicketUserAccess,
  setLorrenSupportTicketUserAccess
} from '../src/services/lorrenSupportTicketAccess.js';
import {
  createLorrenSupportTicket,
  deleteLorrenSupportTicket,
  loadLorrenSupportTicket,
  loadLorrenSupportTickets
} from '../src/services/lorrenSupportTickets.js';

function auditPrisma() {
  const events = [];
  const users = new Map([
    ['user-1', { id: 'user-1', username: 'user-1', displayName: 'Usuario Uno', email: 'uno@example.com', role: 'ADMIN', isActive: true }]
  ]);
  const matches = (row, where = {}) => {
    if (where.entityType && row.entityType !== where.entityType) return false;
    if (where.entityId && typeof where.entityId === 'string' && row.entityId !== where.entityId) return false;
    if (where.entityId?.in && !where.entityId.in.includes(row.entityId)) return false;
    if (where.action && typeof where.action === 'string' && row.action !== where.action) return false;
    if (where.action?.in && !where.action.in.includes(row.action)) return false;
    return true;
  };
  return {
    events,
    appUser: {
      findUnique: async ({ where }) => users.get(where.id) || null
    },
    devAuditEvent: {
      create: async ({ data }) => {
        const row = { id: `event-${events.length + 1}`, createdAt: new Date(Date.now() + events.length), ...data };
        events.push(row);
        return row;
      },
      findFirst: async ({ where }) => [...events].reverse().find((row) => matches(row, where)) || null,
      findMany: async ({ where }) => [...events].reverse().filter((row) => matches(row, where))
    }
  };
}

test('permiso de Tickets se persiste por usuario y DEV conserva acceso implícito', async () => {
  const prisma = auditPrisma();
  assert.equal(await loadLorrenSupportTicketUserAccess(prisma, 'user-1'), false);
  await setLorrenSupportTicketUserAccess(prisma, 'user-1', true, { actorUsername: 'dev' });
  assert.equal(await loadLorrenSupportTicketUserAccess(prisma, 'user-1'), true);
  assert.equal(await canUseLorrenSupportTickets(prisma, { session: { userRole: 'admin', userId: 'user-1' } }), true);
  assert.equal(await canUseLorrenSupportTickets(prisma, { session: { userRole: 'dev' } }), true);
  await setLorrenSupportTicketUserAccess(prisma, 'user-1', false, { actorUsername: 'dev' });
  assert.equal(await canUseLorrenSupportTickets(prisma, { session: { userRole: 'admin', userId: 'user-1' } }), false);
});

test('eliminación DEV es lógica: oculta el ticket y conserva el historial de auditoría', async () => {
  const prisma = auditPrisma();
  const ticket = await createLorrenSupportTicket(prisma, {
    id: 'ticket-1',
    publicCode: 'TCK-00000001',
    originalText: 'Agregar acceso independiente a tickets',
    interpretation: { title: 'Acceso a tickets', suggestedPriority: 'NORMAL' },
    createdByUserId: 'user-1',
    createdByUsername: 'user-1'
  });
  assert.equal((await loadLorrenSupportTickets(prisma)).length, 1);
  await deleteLorrenSupportTicket(prisma, ticket.id, { actorUsername: 'dev' });
  assert.equal(await loadLorrenSupportTicket(prisma, ticket.id), null);
  assert.equal((await loadLorrenSupportTickets(prisma)).length, 0);
  assert.ok(prisma.events.some((row) => row.action === 'LORREN_SUPPORT_TICKET_DELETED'));
  assert.ok(prisma.events.some((row) => row.action === 'LORREN_SUPPORT_TICKET_CREATED'));
});

test('Tickets sale de Reclutamiento y DEV lo recibe como enlace independiente', () => {
  const html = buildAdminModuleNavbar({ session: { userRole: 'dev', userSource: 'env' } }, '<nav class="navbar"></nav>');
  assert.match(html, /data-standalone-link="tickets"/);
  const recruitmentPanel = html.match(/data-module-menu="recruitment"[\s\S]*?<div class="admin-module-menu-panel"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  assert.doesNotMatch(recruitmentPanel, /lorren-tickets|Tickets internos/);
});

test('UI de permisos usa rutas DEV-only y no reemplaza seguridad del servidor', () => {
  const source = fs.readFileSync(new URL('../public/lorren-support-ticket-access.js', import.meta.url), 'utf8');
  assert.match(source, /\/admin\/lorren-tickets\/access\/me/);
  assert.match(source, /\/access\/users/);
  assert.match(source, /Tickets internos/);
  assert.doesNotMatch(source, /\balert\s*\(|\bconfirm\s*\(|\bprompt\s*\(/);
});
