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
  ATTENDANCE_BILLING_ELIGIBILITY_ACTION,
  ATTENDANCE_BILLING_ELIGIBILITY_ENTITY_TYPE
} from '../src/modules/dispatch-attendance/application/attendanceBillingEligibility.js';
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
    serviceRequestId: `request-${id}`,
    status,
    worker: { id: workerId, fullName, documentType: 'CC', documentNumber, isTestProfile },
    serviceRequest: {
      id: `request-${id}`,
      serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
      startTime,
      operationPointId,
      operationPointName: 'Bogotá',
      operationPoint: { id: operationPointId, name: 'Bogotá', attendanceEnabled }
    },
    attendanceSession
  };
}

function whereValueMatches(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (Array.isArray(expected.in)) return expected.in.includes(actual);
    if (typeof expected.startsWith === 'string') return String(actual || '').startsWith(expected.startsWith);
  }
  return actual === expected;
}

function eventMatches(event, where = {}) {
  return Object.entries(where).every(([key, expected]) => whereValueMatches(event[key], expected));
}

function prismaWithAssignments(initialAssignments, { events = [] } = {}) {
  const calls = [];
  const auditEvents = [...events];
  let assignments = [...initialAssignments];
  return {
    calls,
    auditEvents,
    setAssignments(next) { assignments = [...next]; },
    dispatchAssignment: {
      async findMany(args) { calls.push(args); return assignments; }
    },
    devAuditEvent: {
      async findFirst(query) {
        const matches = auditEvents.filter((event) => eventMatches(event, query.where || {}));
        return matches.at(-1) || null;
      },
      async findMany(query) {
        const matches = auditEvents.filter((event) => eventMatches(event, query.where || {}));
        const ordered = query.orderBy?.[0]?.createdAt === 'asc' ? matches : matches.slice().reverse();
        return ordered.slice(0, query.take || 100);
      },
      async create({ data }) {
        const row = { id: `audit-${auditEvents.length + 1}`, createdAt: new Date(), ...data };
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
  assert.equal(cycle.status, 'OPEN');
});

test('antes de la fecha oficial el contador queda en cero y no consulta asignaciones', async () => {
  const prisma = prismaWithAssignments([assignment({ id: 'a1', workerId: 'w1', fullName: 'Previo', documentNumber: '1', serviceDate: '2026-09-20' })]);
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-09-20T20:00:00.000Z'), env: {} });
  assert.equal(counter.status, 'UPCOMING');
  assert.equal(counter.count, 0);
  assert.equal(prisma.calls.length, 0);
});

test('la vista previa cuenta elegibles reales sin crear snapshots', async () => {
  const prisma = prismaWithAssignments([assignment({ id: 'preview-1', workerId: 'worker-1', fullName: 'Prueba', documentNumber: '100', serviceDate: '2026-10-02' })]);
  const before = prisma.auditEvents.length;
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-03T15:00:00.000Z'), readOnly: true, env: {} });
  assert.equal(counter.count, 1);
  assert.equal(prisma.auditEvents.length, before);
});

test('sin fecha persistida ni variable de entorno no inventa un inicio contractual', async () => {
  const prisma = prismaWithAssignments([]);
  const counters = await loadAttendanceBillingCounters(prisma, { now: new Date('2026-09-30T20:00:00.000Z'), env: {} });
  assert.equal(counters.settings.configured, false);
  assert.equal(counters.current, null);
  assert.equal(counters.previous, null);
});

test('la configuración persistida prevalece sobre el fallback de entorno', async () => {
  const prisma = prismaWithAssignments([], { events: [persistedStartEvent(BILLING_START)] });
  const settings = await loadAttendanceBillingSettings(prisma, { now: new Date('2026-10-02T15:00:00.000Z'), env: { ATTENDANCE_BILLING_START_DATE: '2026-09-08' } });
  assert.equal(settings.billingStartDate, BILLING_START);
  assert.equal(settings.source, 'PERSISTED');
});

test('DEV guarda fecha oficial con auditoría e idempotencia', async () => {
  const prisma = prismaWithAssignments([]);
  const first = await saveAttendanceBillingStartDate(prisma, { billingStartDate: BILLING_START, actorUsername: 'dev', actorRole: 'dev' });
  assert.equal(first.changed, true);
  const duplicate = await saveAttendanceBillingStartDate(prisma, { billingStartDate: BILLING_START, actorUsername: 'dev', actorRole: 'dev' });
  assert.equal(duplicate.changed, false);
  assert.equal(prisma.auditEvents.filter((event) => event.entityType === ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE).length, 1);
});

test('solo DEV puede configurar el inicio del contador', () => {
  assert.equal(canConfigureAttendanceBilling({ session: { userRole: 'dev' } }), true);
  assert.equal(canConfigureAttendanceBilling({ session: { userRole: 'admin' } }), false);
});

test('antes de la hora exacta del servicio un CONFIRMED no es facturable', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'a1', workerId: 'w1', fullName: 'Ana', documentNumber: '101', serviceDate: '2026-10-01', startTime: '08:00' })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    billingStartDate: BILLING_START,
    now: new Date('2026-10-01T05:08:00.000Z'),
    env: {}
  });
  assert.equal(counter.count, 0);
  assert.equal(prisma.auditEvents.filter((event) => event.entityType === ATTENDANCE_BILLING_ELIGIBILITY_ENTITY_TYPE).length, 0);
});

test('a la hora exacta del servicio congela la elegibilidad si sigue CONFIRMED y Asistencia está habilitada', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'a1', workerId: 'w1', fullName: 'Ana', documentNumber: '101', serviceDate: '2026-10-01', startTime: '08:00' })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    billingStartDate: BILLING_START,
    now: new Date('2026-10-01T13:00:00.000Z'),
    env: {}
  });
  assert.equal(counter.count, 1);
  assert.equal(counter.workers[0].reason, 'SERVICE_START_LOCKED');
  assert.equal(prisma.auditEvents.filter((event) => event.action === ATTENDANCE_BILLING_ELIGIBILITY_ACTION).length, 1);
});

test('retirado antes de la hora no queda facturable', async () => {
  const row = assignment({ id: 'a1', workerId: 'w1', fullName: 'Ana', documentNumber: '101', serviceDate: '2026-10-01', startTime: '08:00' });
  const prisma = prismaWithAssignments([row]);
  const before = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-01T12:59:00.000Z'), env: {} });
  assert.equal(before.count, 0);
  prisma.setAssignments([]);
  const after = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-01T14:00:00.000Z'), env: {} });
  assert.equal(after.count, 0);
});

test('retirado después de la hora conserva la elegibilidad congelada', async () => {
  const row = assignment({ id: 'a1', workerId: 'w1', fullName: 'Ana', documentNumber: '101', serviceDate: '2026-10-01', startTime: '08:00' });
  const prisma = prismaWithAssignments([row]);
  const atStart = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-01T13:00:00.000Z'), env: {} });
  assert.equal(atStart.count, 1);
  prisma.setAssignments([]);
  const later = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-01T16:00:00.000Z'), env: {} });
  assert.equal(later.count, 1);
  assert.equal(later.workers[0].documentNumber, '101');
});

test('marca tarde, no marca o no llega no cambia la regla comercial después de la hora', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'late', workerId: 'w1', fullName: 'Llegó tarde', documentNumber: '201', serviceDate: '2026-10-05', attendanceSession: { id: 'session-late' } }),
    assignment({ id: 'none', workerId: 'w2', fullName: 'Sin marca', documentNumber: '202', serviceDate: '2026-10-05' })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-05T15:00:00.000Z'), env: {} });
  assert.equal(counter.count, 2);
  assert.ok(counter.workers.every((worker) => worker.reason === 'SERVICE_START_LOCKED'));
});

test('Despacho sin Asistencia no convierte un CONFIRMED en facturable', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'dispatch-only', workerId: 'w1', fullName: 'Solo Despacho', documentNumber: '500', serviceDate: '2026-10-05', attendanceEnabled: false })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-20T15:00:00.000Z'), env: {} });
  assert.equal(counter.count, 0);
});

test('usa el estado histórico de Asistencia a la hora del servicio', async () => {
  const disabledLater = enablementEvent({ at: '2026-10-10T15:00:00.000Z', previous: true, enabled: false });
  const prisma = prismaWithAssignments([
    assignment({ id: 'before', workerId: 'w1', fullName: 'Antes', documentNumber: '501', serviceDate: '2026-10-05', attendanceEnabled: false }),
    assignment({ id: 'after', workerId: 'w2', fullName: 'Después', documentNumber: '502', serviceDate: '2026-10-15', attendanceEnabled: false })
  ], { events: [disabledLater] });
  const counter = await loadAttendanceBillingCounter(prisma, { billingStartDate: BILLING_START, now: new Date('2026-10-20T15:00:00.000Z'), env: {} });
  assert.equal(counter.count, 1);
  assert.equal(counter.workers[0].documentNumber, '501');
});

test('excluye perfiles de prueba, pendientes, hora futura y servicios futuros', async () => {
  const prisma = prismaWithAssignments([
    assignment({ id: 'test', workerId: 'wt', fullName: 'TEST', documentNumber: '999', isTestProfile: true, serviceDate: '2026-10-10' }),
    assignment({ id: 'assigned', workerId: 'wa', fullName: 'Asignado', documentNumber: '333', status: 'ASSIGNED', serviceDate: '2026-10-10' }),
    assignment({ id: 'later-today', workerId: 'wl', fullName: 'Más tarde', documentNumber: '444', serviceDate: '2026-10-20', startTime: '18:00' }),
    assignment({ id: 'future', workerId: 'wf', fullName: 'Futuro', documentNumber: '777', serviceDate: '2026-10-30' })
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
    assignment({ id: 'a1', workerId: 'w1', fullName: 'Ana', documentNumber: '111', serviceDate: '2026-10-03' }),
    assignment({ id: 'a2', workerId: 'w2', fullName: 'Bruno', documentNumber: '222', serviceDate: '2026-10-05' })
  ], { events: [persistedStartEvent(BILLING_START)] });
  const first = await ensureAttendanceBillingInvoice(prisma, { now: new Date('2026-11-01T15:00:00.000Z'), env: {} });
  assert.equal(first.created, true);
  assert.equal(first.invoice.invoiceNumber, 'ASIS-202610');
  assert.equal(first.invoice.count, 2);
  assert.equal(first.invoice.total, 15000);
  const duplicate = await ensureAttendanceBillingInvoice(prisma, { now: new Date('2026-11-01T16:00:00.000Z'), env: {} });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.reason, 'already_issued');
  assert.equal(prisma.auditEvents.filter((event) => event.entityType === ATTENDANCE_BILLING_INVOICE_ENTITY_TYPE && event.action === ATTENDANCE_BILLING_INVOICE_ACTION).length, 1);
});

test('la UI muestra ciclo 1→1 y facturas históricas sin diálogos bloqueantes', () => {
  const ui = fs.readFileSync(new URL('../src/public/attendance-admin-billing-counter.js', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
  assert.match(ui, /Contador del ciclo 1 → 1/);
  assert.match(ui, /Facturas del módulo/);
  assert.match(ui, /window\.setInterval\(refreshCounter, AUTO_REFRESH_MS\)/);
  assert.doesNotMatch(ui, /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  assert.match(route, /router\.post\('\/billing-counter\/start-date', formParser/);
});
