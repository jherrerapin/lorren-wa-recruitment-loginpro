import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDispatchWhatsappOutboundHistoryByDate } from '../src/services/dispatchWhatsappMonitor.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function auditRow({ id, phone, status, at, body, source = 'ASSIGNMENT_CONFIRMATION', diagnostic = null }) {
  return {
    id,
    entityType: 'DISPATCH_WHATSAPP_MESSAGE',
    entityId: `dispatch-wa:outbound:${id}`,
    entityLabel: phone,
    action: 'DISPATCH_WHATSAPP_OUTBOUND',
    actorSource: source,
    metadata: {
      scope: 'operational',
      direction: 'OUTBOUND',
      phone,
      body,
      messageType: 'TEMPLATE',
      providerMessageId: id,
      providerStatus: status,
      providerStatusAt: at,
      providerDiagnostic: diagnostic,
      source,
      occurredAt: at
    },
    createdAt: new Date(at)
  };
}

function prismaFixture(rows) {
  return {
    devAuditEvent: {
      findMany: async (query) => {
        assert.equal(query.where.entityType, 'DISPATCH_WHATSAPP_MESSAGE');
        assert.equal(query.where.action, 'DISPATCH_WHATSAPP_OUTBOUND');
        assert.deepEqual(query.orderBy, { createdAt: 'desc' });
        assert.equal(query.take, 500);
        return rows;
      }
    },
    dispatchWorker: {
      findMany: async (query) => {
        assert.deepEqual(query.where, { phone: { not: null } });
        assert.deepEqual(query.select, { fullName: true, phone: true });
        return [
          { fullName: 'Auxiliar Uno', phone: '3001112233' },
          { fullName: 'Auxiliar Dos', phone: '3002223344' }
        ];
      }
    }
  };
}

test('historial outbound consulta exactamente el día de Bogotá y conserva estado Meta', async () => {
  const rows = [
    auditRow({
      id: 'wamid-test-failed',
      phone: '573003334455',
      status: 'FAILED',
      at: '2026-09-21T00:20:00.000Z',
      body: 'Asignación ficticia C',
      diagnostic: 'code=131000 error de prueba saneado'
    }),
    auditRow({
      id: 'wamid-test-delivered',
      phone: '573002223344',
      status: 'DELIVERED',
      at: '2026-09-21T00:10:00.000Z',
      body: 'Asignación ficticia B'
    }),
    auditRow({
      id: 'wamid-test-accepted',
      phone: '573001112233',
      status: 'ACCEPTED',
      at: '2026-09-21T00:05:00.000Z',
      body: 'Asignación ficticia A'
    })
  ];
  const prismaClient = prismaFixture(rows);
  const originalFindMany = prismaClient.devAuditEvent.findMany;
  prismaClient.devAuditEvent.findMany = async (query) => {
    assert.equal(query.where.createdAt.gte.toISOString(), '2026-09-20T05:00:00.000Z');
    assert.equal(query.where.createdAt.lt.toISOString(), '2026-09-21T05:00:00.000Z');
    return originalFindMany(query);
  };

  const history = await loadDispatchWhatsappOutboundHistoryByDate({
    prismaClient,
    dateKey: '2026-09-20',
    now: NOW
  });

  assert.equal(history.dateKey, '2026-09-20');
  assert.equal(history.range.start, '2026-09-20T05:00:00.000Z');
  assert.equal(history.range.end, '2026-09-21T05:00:00.000Z');
  assert.deepEqual(history.summary, {
    total: 3,
    accepted: 1,
    sent: 0,
    delivered: 1,
    read: 0,
    failed: 1,
    withoutProviderStatus: 0
  });
  assert.equal(history.items[0].providerStatus, 'FAILED');
  assert.equal(history.items[0].providerDiagnostic, 'code=131000 error de prueba saneado');
  assert.equal(history.items[0].phoneMasked, '•••• 4455');
  assert.equal(history.items[1].workerName, 'Auxiliar Dos');
  assert.equal(history.items[1].phoneMasked, '•••• 3344');
  assert.equal(history.items[2].workerName, 'Auxiliar Uno');
  assert.equal(history.items[2].phoneMasked, '•••• 2233');
});

test('fecha inválida usa el día actual de Bogotá sin ampliar el rango', async () => {
  const prismaClient = {
    devAuditEvent: {
      findMany: async (query) => {
        assert.equal(query.where.createdAt.gte.toISOString(), '2026-09-21T05:00:00.000Z');
        assert.equal(query.where.createdAt.lt.toISOString(), '2026-09-22T05:00:00.000Z');
        return [];
      }
    }
  };
  const history = await loadDispatchWhatsappOutboundHistoryByDate({
    prismaClient,
    dateKey: '2026-99-99',
    now: NOW
  });
  assert.equal(history.dateKey, '2026-09-21');
  assert.equal(history.summary.total, 0);
  assert.deepEqual(history.items, []);
});

test('pantalla y ruta reutilizan la autoridad existente para seleccionar fecha', () => {
  const view = fs.readFileSync(new URL('../src/views/operacionesWhatsappEstado.ejs', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/dispatchWhatsappNotifications.js', import.meta.url), 'utf8');

  assert.match(view, /name="date" type="date"/);
  assert.match(view, /Aceptado por Meta/);
  assert.match(view, /no significa que el mensaje haya sido entregado al teléfono/);
  assert.match(view, /providerStatus === 'FAILED'/);
  assert.match(route, /loadDispatchWhatsappOutboundHistoryByDate/);
  assert.match(route, /dateKey:\s*normalizeString\(req\.query\?\.date\)/);
});
