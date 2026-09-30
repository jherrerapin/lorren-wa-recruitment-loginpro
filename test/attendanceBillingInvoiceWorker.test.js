import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_BILLING_INVOICE_DELIVERY_ACTION,
  ATTENDANCE_BILLING_INVOICE_DELIVERY_ENTITY_TYPE,
  buildAttendanceBillingInvoiceWhatsappText,
  deliverAttendanceBillingInvoice
} from '../src/workers/attendanceBillingInvoiceWorker.js';

function invoice() {
  return {
    invoiceNumber: 'ASIS-202610',
    cycleStart: '2026-10-01',
    cycleEnd: '2026-11-01',
    paymentDate: '2026-11-15',
    count: 42,
    unitPrice: 7500,
    total: 315000,
    currency: 'COP'
  };
}

function prismaForDelivery() {
  const events = [];
  return {
    events,
    devAuditEvent: {
      async findFirst({ where }) {
        return events.find((event) => (
          event.entityType === where.entityType
          && event.entityId === where.entityId
          && event.action === where.action
        )) || null;
      },
      async create({ data }) {
        const event = { id: `event-${events.length + 1}`, createdAt: new Date(), ...data };
        events.push(event);
        return event;
      }
    }
  };
}

test('el mensaje de factura contiene periodo, cantidad, tarifa, total y pago', () => {
  const body = buildAttendanceBillingInvoiceWhatsappText(invoice());
  assert.match(body, /Factura ASIS-202610/);
  assert.match(body, /Auxiliares facturables: 42/);
  assert.match(body, /7\.500/);
  assert.match(body, /315\.000/);
  assert.match(body, /15 de noviembre de 2026/);
  assert.match(body, /módulo de Asistencia y Gestión de Tiempo/);
});

test('la entrega por WhatsApp es idempotente por factura y usuario', async () => {
  const prisma = prismaForDelivery();
  const sent = [];
  const recipients = [
    { userId: 'dev-1', username: 'dev', displayName: 'DEV', role: 'DEV', phone: '573001112233' },
    { userId: 'sup-1', username: 'supervisor', displayName: 'Supervisor', role: 'SUPERVISOR', phone: '573004445566' }
  ];
  const sendText = async ({ phone, text }) => {
    sent.push({ phone, text });
    return `wamid-${sent.length}`;
  };

  const first = await deliverAttendanceBillingInvoice(prisma, invoice(), { recipients, sendText });
  assert.equal(first.sent, 2);
  assert.equal(first.failed, 0);
  assert.equal(sent.length, 2);
  assert.equal(prisma.events.filter((event) => event.entityType === ATTENDANCE_BILLING_INVOICE_DELIVERY_ENTITY_TYPE).length, 2);
  assert.ok(prisma.events.every((event) => event.action === ATTENDANCE_BILLING_INVOICE_DELIVERY_ACTION));

  const second = await deliverAttendanceBillingInvoice(prisma, invoice(), { recipients, sendText });
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 2);
  assert.equal(sent.length, 2);
});

test('un fallo del proveedor no se marca como enviado y queda disponible para reintento', async () => {
  const prisma = prismaForDelivery();
  const recipients = [
    { userId: 'sup-1', username: 'supervisor', displayName: 'Supervisor', role: 'SUPERVISOR', phone: '573004445566' }
  ];
  const first = await deliverAttendanceBillingInvoice(prisma, invoice(), {
    recipients,
    sendText: async () => { throw new Error('outside_window'); }
  });
  assert.equal(first.failed, 1);
  assert.equal(prisma.events.length, 0);

  const second = await deliverAttendanceBillingInvoice(prisma, invoice(), {
    recipients,
    sendText: async () => 'wamid-retry'
  });
  assert.equal(second.sent, 1);
  assert.equal(prisma.events.length, 1);
});
