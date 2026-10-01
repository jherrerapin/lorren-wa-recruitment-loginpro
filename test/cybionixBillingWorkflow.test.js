import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LORREN_ACCOUNT_ENTITY_TYPE,
  ensureLorrenAccountCharge,
  loadLorrenAccountForInvoice,
  loadLorrenApprovalState,
  resolveLorrenAttendanceApproval
} from '../src/services/cybionixBillingWorkflow.js';
import {
  LORREN_BILLING_CONFIG_ACTION,
  LORREN_BILLING_CONFIG_ENTITY_ID,
  LORREN_BILLING_CONFIG_ENTITY_TYPE,
  normalizeLorrenBillingConfigInput
} from '../src/services/cybionixBillingConfig.js';
import {
  ATTENDANCE_BILLING_INVOICE_ACTION,
  ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE
} from '../src/modules/dispatch-attendance/application/attendanceBillingCounter.js';

function configMetadata() {
  return {
    enabled: true,
    modules: [
      { id: 'fixed-1', name: 'Bot', value: 1000000, active: true, source: 'FIXED' },
      { id: 'fixed-2', name: 'Despacho', value: 400000, active: true, source: 'FIXED' }
    ],
    recipients: [{ id: 'recipient-1', name: 'Milton Perez', phone: '573001112233', active: true }],
    supervisor: { name: 'Supervisor', phone: '573004445566' },
    devAlertPhone: null,
    accountHeading: 'MILTON PEREZ'
  };
}

function invoiceMetadata() {
  return {
    invoiceNumber: 'ASIS-202610',
    cycleStart: '2026-10-01',
    cycleEnd: '2026-11-01',
    cutDate: '2026-11-01',
    paymentDate: '2026-11-15',
    count: 42,
    unitPrice: 7500,
    total: 315000,
    currency: 'COP',
    workers: []
  };
}

function matches(event, where = {}) {
  if (where.entityType && event.entityType !== where.entityType) return false;
  if (where.entityId && typeof where.entityId === 'string' && event.entityId !== where.entityId) return false;
  if (where.entityId?.in && !where.entityId.in.includes(event.entityId)) return false;
  if (where.action && event.action !== where.action) return false;
  return true;
}

function makePrisma() {
  const events = [
    {
      id: 'config-1',
      createdAt: new Date('2026-09-30T22:00:00.000Z'),
      entityType: LORREN_BILLING_CONFIG_ENTITY_TYPE,
      entityId: LORREN_BILLING_CONFIG_ENTITY_ID,
      action: LORREN_BILLING_CONFIG_ACTION,
      metadata: configMetadata()
    },
    {
      id: 'invoice-1',
      createdAt: new Date('2026-11-01T05:05:00.000Z'),
      entityType: ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE,
      entityId: '2026-10-01',
      action: ATTENDANCE_BILLING_INVOICE_ACTION,
      metadata: invoiceMetadata()
    }
  ];
  return {
    events,
    devAuditEvent: {
      async findFirst({ where = {} } = {}) {
        return [...events].filter((event) => matches(event, where)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
      },
      async findMany({ where = {}, take } = {}) {
        const rows = [...events].filter((event) => matches(event, where)).sort((a, b) => b.createdAt - a.createdAt);
        return typeof take === 'number' ? rows.slice(0, take) : rows;
      },
      async create({ data }) {
        if (data.id && events.some((event) => event.id === data.id)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
        const event = { id: data.id || `event-${events.length + 1}`, createdAt: new Date(Date.now() + events.length), ...data };
        events.push(event);
        return event;
      }
    }
  };
}

test('la configuración DEV normaliza módulos, destinatarios y teléfonos colombianos', () => {
  const normalized = normalizeLorrenBillingConfigInput({
    enabled: 'true',
    moduleName: ['Bot', 'Despacho'],
    moduleValue: ['1.000.000', '400000'],
    moduleActive: ['0', '1'],
    recipientName: ['Milton Perez'],
    recipientPhone: ['3001112233'],
    supervisorName: 'Supervisor',
    supervisorPhone: '3004445566'
  });
  assert.equal(normalized.modules[0].value, 1000000);
  assert.equal(normalized.modules[1].value, 400000);
  assert.equal(normalized.recipients[0].phone, '573001112233');
  assert.equal(normalized.supervisor.phone, '573004445566');
});

test('una aprobación crea una sola cuenta con Bot + Despacho + Asistencia', async () => {
  const prisma = makePrisma();
  const first = await resolveLorrenAttendanceApproval(prisma, {
    invoiceNumber: 'ASIS-202610',
    decision: 'APPROVE',
    supervisorPhone: '573004445566'
  }, { env: {} });

  assert.equal(first.ok, true);
  assert.equal(first.status, 'APPROVED');
  assert.equal(first.account.total, 1715000);
  assert.deepEqual(first.account.items.map((item) => item.name), ['Bot', 'Despacho', 'Módulo de Asistencia y Gestión de Tiempo']);
  assert.equal(first.account.recipients[0].phone, '573001112233');

  const second = await resolveLorrenAttendanceApproval(prisma, {
    invoiceNumber: 'ASIS-202610',
    decision: 'APPROVE',
    supervisorPhone: '573004445566'
  }, { env: {} });
  assert.equal(second.idempotent, true);
  assert.equal(prisma.events.filter((event) => event.entityType === LORREN_ACCOUNT_ENTITY_TYPE).length, 1);
});

test('la primera decisión terminal gana: rechazo impide crear la cuenta aunque llegue un approve duplicado', async () => {
  const prisma = makePrisma();
  const rejected = await resolveLorrenAttendanceApproval(prisma, {
    invoiceNumber: 'ASIS-202610',
    decision: 'REJECT',
    supervisorPhone: '573004445566'
  }, { env: {} });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(await loadLorrenAccountForInvoice(prisma, 'ASIS-202610'), null);

  const lateApprove = await resolveLorrenAttendanceApproval(prisma, {
    invoiceNumber: 'ASIS-202610',
    decision: 'APPROVE',
    supervisorPhone: '573004445566'
  }, { env: {} });
  assert.equal(lateApprove.idempotent, true);
  assert.equal(lateApprove.status, 'REJECTED');
  assert.equal(await loadLorrenAccountForInvoice(prisma, 'ASIS-202610'), null);
});

test('ensure de cuenta usa snapshot y es idempotente por factura', async () => {
  const prisma = makePrisma();
  const invoice = invoiceMetadata();
  const first = await ensureLorrenAccountCharge(prisma, invoice, configMetadata(), { supervisorName: 'Supervisor', supervisorPhone: '573004445566' });
  const second = await ensureLorrenAccountCharge(prisma, invoice, configMetadata(), { supervisorName: 'Supervisor', supervisorPhone: '573004445566' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.account.total, 1715000);
  const state = await loadLorrenApprovalState(prisma, 'ASIS-202610');
  assert.equal(state.status, 'UNSENT');
});
