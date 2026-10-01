import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ATTENDANCE_BILLING_CONFIG_ACTION,
  ATTENDANCE_BILLING_CONFIG_ENTITY_ID,
  ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE,
  ATTENDANCE_BILLING_CUT_DAY,
  ATTENDANCE_BILLING_PAYMENT_DAY,
  ATTENDANCE_BILLING_INVOICE_ACTION,
  ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE,
  attendanceBillingPriceForCount,
  ensureAttendanceBillingInvoice,
  loadAttendanceBillingCounter,
  loadAttendanceBillingCounters,
  loadAttendanceBillingSettings,
  resolveAttendanceBillingCycle,
  saveAttendanceBillingStartDate
} from '../src/modules/dispatch-attendance/application/attendanceBillingCounter.js';
import {
  ATTENDANCE_POINT_ENABLEMENT_ACTION,
  ATTENDANCE_POINT_ENABLEMENT_ENTITY_TYPE
} from '../src/modules/dispatch-attendance/application/updatePointConfig.js';
import { canConfigureAttendanceBilling } from '../src/routes/dispatchAttendanceAdmin.js';

const BILLING_START = '2026-10-01';

function assignment({
  id,
  workerId,
  fullName,
  documentNumber,
  isTestProfile = false,
  status = 'CONFIRMED',
  serviceDate,
  startTime = '08:00',
  attendanceEnabled = true,
  operationPointId = 'point-1',
  attendanceSession = null
}) {
  return {
    id,
    workerId,
    status,
    worker: {
      id: workerId,
      fullName,
      documentType: 'CC',
      documentNumber,
      isTestProfile
    },
    serviceRequest: {
      serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
      startTime,
      operationPointId,
      operationPoint: { id: operationPointId, attendanceEnabled }
    },
    attendanceSession
  };
}

function prismaWithAssignments(assignments, { events = [] } = {}) {
  const calls = [];
  const auditEvents = [...events];
  return {
    calls,
    auditEvents,
    dispatchAssignment: {
      async findMany(args) {
        calls.push(args);
        return assignments;
      }
    },
    devAuditEvent: {
      async findFirst(query) {
        const matches = auditEvents.filter((event) => (
          event.entityType === query.where.entityType
          && event.entityId === query.where.entityId
          && event.action === query.where.action
        ));
        return matches.at(-1) || null;
      },
      async findMany(query) {
        return auditEvents
          .filter((event) => (
            event.entityType === query.where.entityType
            && event.action === query.where.action
            && (!query.where.entityId?.in || query.where.entityId.in.includes(event.entityId))
          ))
          .slice()
          .reverse()
          .slice(0, query.take || 100);
      },
      async create({ data }) {
        const row = {
          id: `audit-${auditEvents.length + 1}`,
          createdAt: new Date(`2026-11-01T${String(10 + auditEvents.length).padStart(2, '0')}:00:00.000Z`),
          ...data
        };
        auditEvents.push(row);
        return row;
      }
    }
  };
}

function persistedStartEvent(dateKey) {
  return {
    id: `audit-${dateKey}`,
    entityType: ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE,
    entityId: ATTENDANCE_BILLING_CONFIG_ENTITY_ID,
    entityLabel: 'Inicio oficial del contador de asistencia',
    action: ATTENDANCE_BILLING_CONFIG_ACTION,
    metadata: { billingStartDate: dateKey, cutDay: 1, paymentDay: 15 },
    toValue: { billingStartDate: dateKey },
    createdAt: new Date('2026-09-30T20:00:00.000Z')
  };
}

function enablementEvent({ operationPointId = 'point-1', at, previous, enabled }) {
  return {
    id: `enablement-${at}`,
    entityType: ATTENDANCE_POINT_ENABLEMENT_ENTITY_TYPE,
    entityId: operationPointId,
    action: ATTENDANCE_POINT_ENABLEMENT_ACTION,
    createdAt: new Date(at),
    metadata: { operationPointId, previousAttendanceEnabled: previous, attendanceEnabled: enabled }
  };
}

test('el ciclo facturable es calendario 1 → 1 y paga el día 15', () => {
  assert.equal(ATTENDANCE_BILLING_CUT_DAY, 1);
  assert.equal(ATTENDANCE_BILLING_PAYMENT_DAY, 15);
  const cycle = resolveAttendanceBillingCycle({ billingStartDate: BILLING_START, now: new Date('2026-10-20T15:00:00.000Z') });
  assert.equal(cycle.start, '2026-10-01');
  assert.equal(cycle.end, '2026-10-31');
  assert.equal(cycle.endExclusive, '2026-11-01');
  assert.equal(cycle.cutDate, '2026-11-01');
  assert.equal(cycle.paymentDate, '2026-11-15');
  assert.equal(cycle.effectiveTo, '2026-10-20');
  assert.equal(cycle.status, 'OPEN');
});

test('el primero cambia al nuevo ciclo y conserva el mes anterior como cerrado', async () => {
  const prisma = prismaWithAssignments([], { events: [persistedStartEvent(BILLING_START)] });
  const counters = await loadAttendanceBillingCounters(prisma, { now: new Date('2026-11-01T15:00:00.000Z'), env: {} });
  assert.equal(counters.current.start, '2026-11-01');
  assert.equal(counters.current.endExclusive, '2026-12-01');
  assert.equal(counters.current.paymentDate, '2026-12-15');
  assert.equal(counters.previous.start, '2026-10-01');
  assert.equal(counters.previous.end, '2026-10-31');
  assert.equal(counters.previous.status, 'CLOSED');
});

test('antes de la fecha oficial el contador queda en cero y no consulta asignaciones', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'a1', workerId: 'w1', fullName: 'Auxiliar previo', documentNumber: 'TEST-100', serviceDate: '2026-09-20', attendanceSession: { id: 's1' } })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-09-20T20:00:00.000Z'), env: {} });
  assert.equal(counter.start, BILLING_START);
  assert.equal(counter.status, 'UPCOMING');
  assert.equal(counter.count, 0);
  assert.equal(prisma.calls.length, 0);
});

test('sin fecha persistida ni variable de entorno no inventa un inicio contractual', async () => {
  const prisma = prismaWithAssignments([]);
  const counters = await loadAttendanceBillingCounters(prisma, { now: new Date('2026-09-30T20:00:00.000Z'), env: {} });
  assert.equal(counters.settings.configured, false);
  assert.equal(counters.settings.source, 'UNCONFIGURED');
  assert.equal(counters.current, null);
  assert.equal(counters.previous, null);
  assert.deepEqual(counters.invoices, []);
  assert.equal(prisma.calls.length, 0);
});

test('la configuración persistida prevalece sobre el fallback de entorno', async () => {
  const prisma = prismaWithAssignments([], { events: [persistedStartEvent(BILLING_START)] });
  const settings = await loadAttendanceBillingSettings(prisma, {
    now: new Date('2026-10-02T15:00:00.000Z'),
    env: { ATTENDANCE_BILLING_START_DATE: '2026-09-08' }
  });
  assert.equal(settings.billingStartDate, BILLING_START);
  assert.equal(settings.source, 'PERSISTED');
  assert.equal(settings.cutDay, 1);
  assert.equal(settings.paymentDay, 15);
});

test('DEV guarda fecha oficial con auditoría e idempotencia', async () => {
  const prisma = prismaWithAssignments([]);
  const first = await saveAttendanceBillingStartDate(prisma, { billingStartDate: BILLING_START, actorUsername: 'dev-prueba', actorRole: 'dev' });
  assert.equal(first.changed, true);
  assert.equal(prisma.auditEvents.length, 1);
  assert.equal(prisma.auditEvents[0].metadata.cutDay, 1);
  assert.equal(prisma.auditEvents[0].metadata.paymentDay, 15);
  const duplicate = await saveAttendanceBillingStartDate(prisma, { billingStartDate: BILLING_START, actorUsername: 'dev-prueba', actorRole: 'dev' });
  assert.equal(duplicate.changed, false);
  assert.equal(prisma.auditEvents.length, 1);
});

test('solo DEV puede configurar el inicio del contador', () => {
  assert.equal(canConfigureAttendanceBilling({ session: { userRole: 'dev' } }), true);
  assert.equal(canConfigureAttendanceBilling({ userRole: 'dev' }), true);
  assert.equal(canConfigureAttendanceBilling({ session: { userRole: 'admin' } }), false);
  assert.equal(canConfigureAttendanceBilling({}), false);
});

test('cuenta una vez por auxiliar real si tuvo asistencia o ausencia confirmada en una operación con Asistencia', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'a1', workerId: 'w1', fullName: 'Ana Uno', documentNumber: 'TEST-1111', serviceDate: '2026-10-03', attendanceSession: { id: 's1' } }),
    assignment({ id: 'a2', workerId: 'w1', fullName: 'Ana Uno', documentNumber: 'TEST-1111', serviceDate: '2026-10-04', attendanceSession: { id: 's2' } }),
    assignment({ id: 'a3', workerId: 'w2', fullName: 'Bruno Dos', documentNumber: 'TEST-2222', serviceDate: '2026-10-05', status: 'CONFIRMED', attendanceEnabled: true })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-20T15:00:00.000Z'), env: {} });
  assert.equal(counter.count, 2);
  assert.equal(counter.workers[0].serviceDays, 2);
  assert.equal(counter.workers[0].reason, 'ATTENDANCE');
  assert.equal(counter.workers[1].reason, 'CONFIRMED_ABSENCE');
});

test('Despacho sin Asistencia no convierte un CONFIRMED en facturable', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'dispatch-only', workerId: 'w1', fullName: 'Solo Despacho', documentNumber: 'TEST-500', serviceDate: '2026-10-05', status: 'CONFIRMED', attendanceEnabled: false })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-20T15:00:00.000Z'), env: {} });
  assert.equal(counter.count, 0);
});

test('la ausencia usa el estado de Asistencia vigente a la hora del servicio, no el valor actual', async () => {
  const disabledAfterFirstService = enablementEvent({
    at: '2026-10-10T15:00:00.000Z',
    previous: true,
    enabled: false
  });
  const prisma = prismaWithAssignments([
    assignment({ id: 'before-disable', workerId: 'w1', fullName: 'Antes del cambio', documentNumber: 'TEST-501', serviceDate: '2026-10-05', status: 'CONFIRMED', attendanceEnabled: false }),
    assignment({ id: 'after-disable', workerId: 'w2', fullName: 'Después del cambio', documentNumber: 'TEST-502', serviceDate: '2026-10-15', status: 'CONFIRMED', attendanceEnabled: false })
  ], { events: [disabledAfterFirstService] });
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-20T15:00:00.000Z'), env: {} });
  assert.equal(counter.count, 1);
  assert.equal(counter.workers[0].documentNumber, 'TEST-501');
});

test('una sesión real de Asistencia conserva la facturabilidad aunque el punto luego quede deshabilitado', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'marked', workerId: 'w1', fullName: 'Marcó asistencia', documentNumber: 'TEST-503', serviceDate: '2026-10-05', attendanceEnabled: false, attendanceSession: { id: 'session-1' } })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-20T15:00:00.000Z'), env: {} });
  assert.equal(counter.count, 1);
  assert.equal(counter.workers[0].reason, 'ATTENDANCE');
});

test('excluye perfiles de prueba, pendientes y servicios futuros', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'test', workerId: 'wt', fullName: 'TEST Perfil', documentNumber: 'TEST-999', isTestProfile: true, serviceDate: '2026-10-10', attendanceSession: { id: 'st' } }),
    assignment({ id: 'assigned', workerId: 'wa', fullName: 'Asignado', documentNumber: 'TEST-333', status: 'ASSIGNED', serviceDate: '2026-10-10' }),
    assignment({ id: 'future', workerId: 'wf', fullName: 'Futuro', documentNumber: 'TEST-777', serviceDate: '2026-10-30', status: 'CONFIRMED' })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-20T15:00:00.000Z'), env: {} });
  assert.equal(counter.count, 0);
});

test('las tarifas aplican el rango alcanzado a la totalidad del ciclo', () => {
  assert.deepEqual(attendanceBillingPriceForCount(0), { count: 0, unitPrice: 0, total: 0, currency: 'COP', tier: null });
  assert.equal(attendanceBillingPriceForCount(1).unitPrice, 7500);
  assert.equal(attendanceBillingPriceForCount(50).total, 375000);
  assert.equal(attendanceBillingPriceForCount(51).unitPrice, 7000);
  assert.equal(attendanceBillingPriceForCount(100).total, 700000);
  assert.equal(attendanceBillingPriceForCount(101).unitPrice, 6500);
  assert.equal(attendanceBillingPriceForCount(200).total, 1300000);
  assert.equal(attendanceBillingPriceForCount(201).unitPrice, 6000);
});

test('el primero genera una factura persistente e idempotente del mes cerrado', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'a1', workerId: 'w1', fullName: 'Ana Uno', documentNumber: 'TEST-1111', serviceDate: '2026-10-03', attendanceSession: { id: 's1' } }),
    assignment({ id: 'a2', workerId: 'w2', fullName: 'Bruno Dos', documentNumber: 'TEST-2222', serviceDate: '2026-10-05', status: 'CONFIRMED' })
  ], { events: [persistedStartEvent(BILLING_START)] });

  const first = await ensureAttendanceBillingInvoice(prisma, { now: new Date('2026-11-01T15:00:00.000Z'), env: {} });
  assert.equal(first.created, true);
  assert.equal(first.invoice.invoiceNumber, 'ASIS-202610');
  assert.equal(first.invoice.cycleStart, '2026-10-01');
  assert.equal(first.invoice.cycleEnd, '2026-11-01');
  assert.equal(first.invoice.count, 2);
  assert.equal(first.invoice.unitPrice, 7500);
  assert.equal(first.invoice.total, 15000);
  assert.equal(first.invoice.paymentDate, '2026-11-15');
  assert.equal(first.invoice.workers.length, 2);
  const invoiceEvents = prisma.auditEvents.filter((event) => event.entityType === ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE && event.action === ATTENDANCE_BILLING_INVOICE_ACTION);
  assert.equal(invoiceEvents.length, 1);

  const duplicate = await ensureAttendanceBillingInvoice(prisma, { now: new Date('2026-11-01T16:00:00.000Z'), env: {} });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.reason, 'already_issued');
  assert.equal(prisma.auditEvents.filter((event) => event.entityType === ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE).length, 1);
});

test('la UI muestra ciclo 1→1 y facturas históricas sin diálogos bloqueantes', () => {
  const ui = fs.readFileSync(new URL('../src/public/attendance-admin-billing-counter.js', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
  assert.match(ui, /Contador del ciclo 1 → 1/);
  assert.match(ui, /Día 1 · ciclo 1 → 1/);
  assert.match(ui, /Facturas del módulo/);
  assert.match(ui, /Valor unitario/);
  assert.match(ui, /El día 1 se cierra el mes anterior/);
  assert.match(ui, /START_DATE_ENDPOINT = '\/admin\/operaciones\/asistencia\/billing-counter\/start-date'/);
  assert.match(ui, /window\.setInterval\(refreshCounter, AUTO_REFRESH_MS\)/);
  assert.doesNotMatch(ui, /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  assert.match(route, /router\.post\('\/billing-counter\/start-date', formParser/);
  assert.match(route, /if \(!canConfigureAttendanceBilling\(req\)\)/);
});
