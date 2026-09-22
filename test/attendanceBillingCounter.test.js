import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ATTENDANCE_BILLING_CONFIG_ACTION,
  ATTENDANCE_BILLING_CONFIG_ENTITY_ID,
  ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE,
  ATTENDANCE_BILLING_CUT_DAY,
  loadAttendanceBillingCounter,
  loadAttendanceBillingCounters,
  loadAttendanceBillingSettings,
  resolveAttendanceBillingCycle,
  saveAttendanceBillingStartDate
} from '../src/modules/dispatch-attendance/application/attendanceBillingCounter.js';
import { canConfigureAttendanceBilling } from '../src/routes/dispatchAttendanceAdmin.js';

const LEGACY_FULL_CYCLE_START = '2026-09-08';

function assignment({
  id,
  workerId,
  fullName,
  documentNumber,
  isTestProfile = false,
  status = 'CONFIRMED',
  serviceDate,
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
    serviceRequest: { serviceDate: new Date(`${serviceDate}T00:00:00.000Z`) },
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
      async create({ data }) {
        const row = {
          id: `audit-${auditEvents.length + 1}`,
          createdAt: new Date(`2026-09-21T${String(10 + auditEvents.length).padStart(2, '0')}:00:00.000Z`),
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
    metadata: { billingStartDate: dateKey, cutDay: 8, paymentDay: 8 },
    toValue: { billingStartDate: dateKey },
    createdAt: new Date('2026-09-21T20:00:00.000Z')
  };
}

test('el corte mensual continúa anclado al día 8', () => {
  assert.equal(ATTENDANCE_BILLING_CUT_DAY, 8);
  const cycle = resolveAttendanceBillingCycle({
    billingStartDate: LEGACY_FULL_CYCLE_START,
    now: new Date('2026-10-20T15:00:00.000Z')
  });
  assert.equal(cycle.start, '2026-10-08');
  assert.equal(cycle.end, '2026-11-07');
  assert.equal(cycle.endExclusive, '2026-11-08');
  assert.equal(cycle.paymentDate, '2026-11-08');
  assert.equal(cycle.effectiveTo, '2026-10-20');
  assert.equal(cycle.status, 'OPEN');
});

test('inicio 23 de septiembre crea primer ciclo parcial hasta el 7 de octubre', () => {
  const cycle = resolveAttendanceBillingCycle({
    billingStartDate: '2026-09-23',
    now: new Date('2026-09-23T15:00:00.000Z')
  });
  assert.equal(cycle.start, '2026-09-23');
  assert.equal(cycle.end, '2026-10-07');
  assert.equal(cycle.endExclusive, '2026-10-08');
  assert.equal(cycle.paymentDate, '2026-10-08');
  assert.equal(cycle.isInitialCycle, true);
  assert.equal(cycle.status, 'OPEN');
});

test('inicio entre el 1 y el 7 cierra en el día 7 del mismo mes', () => {
  const cycle = resolveAttendanceBillingCycle({
    billingStartDate: '2026-10-05',
    now: new Date('2026-10-05T15:00:00.000Z')
  });
  assert.equal(cycle.start, '2026-10-05');
  assert.equal(cycle.end, '2026-10-07');
  assert.equal(cycle.paymentDate, '2026-10-08');
});

test('inicio exactamente un día 8 crea un ciclo mensual completo', () => {
  const cycle = resolveAttendanceBillingCycle({
    billingStartDate: '2026-10-08',
    now: new Date('2026-10-08T15:00:00.000Z')
  });
  assert.equal(cycle.start, '2026-10-08');
  assert.equal(cycle.end, '2026-11-07');
  assert.equal(cycle.paymentDate, '2026-11-08');
});

test('el día 8 cambia automáticamente al nuevo ciclo sin borrar el ciclo parcial anterior', async () => {
  const prisma = prismaWithAssignments([], { events: [persistedStartEvent('2026-09-23')] });
  const counters = await loadAttendanceBillingCounters(prisma, {
    now: new Date('2026-10-08T15:00:00.000Z'),
    env: {}
  });
  assert.equal(counters.current.start, '2026-10-08');
  assert.equal(counters.current.end, '2026-11-07');
  assert.equal(counters.current.paymentDate, '2026-11-08');
  assert.equal(counters.previous.start, '2026-09-23');
  assert.equal(counters.previous.end, '2026-10-07');
  assert.equal(counters.previous.paymentDate, '2026-10-08');
  assert.equal(counters.previous.status, 'CLOSED');
});

test('antes de la fecha oficial el contador queda en cero y no consulta asignaciones', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'a1', workerId: 'w1', fullName: 'Auxiliar previo', documentNumber: 'TEST-100',
      serviceDate: '2026-09-20', attendanceSession: { id: 's1' }
    })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    billingStartDate: '2026-09-23',
    now: new Date('2026-09-20T20:00:00.000Z'),
    env: {}
  });
  assert.equal(counter.start, '2026-09-23');
  assert.equal(counter.status, 'UPCOMING');
  assert.equal(counter.count, 0);
  assert.equal(prisma.calls.length, 0);
});

test('sin fecha persistida ni variable de entorno no inventa un inicio contractual', async () => {
  const prisma = prismaWithAssignments([]);
  const counters = await loadAttendanceBillingCounters(prisma, {
    now: new Date('2026-09-21T20:00:00.000Z'),
    env: {}
  });
  assert.equal(counters.settings.configured, false);
  assert.equal(counters.settings.source, 'UNCONFIGURED');
  assert.equal(counters.settings.billingStartDate, null);
  assert.equal(counters.current, null);
  assert.equal(counters.previous, null);
  assert.equal(prisma.calls.length, 0);
});

test('la configuración persistida prevalece sobre el fallback de entorno', async () => {
  const prisma = prismaWithAssignments([], { events: [persistedStartEvent('2026-09-23')] });
  const settings = await loadAttendanceBillingSettings(prisma, {
    now: new Date('2026-09-24T15:00:00.000Z'),
    env: { ATTENDANCE_BILLING_START_DATE: '2026-09-08' }
  });
  assert.equal(settings.billingStartDate, '2026-09-23');
  assert.equal(settings.source, 'PERSISTED');
  assert.equal(settings.today, '2026-09-24');
});

test('DEV guarda fecha oficial con auditoría e idempotencia', async () => {
  const prisma = prismaWithAssignments([]);
  const first = await saveAttendanceBillingStartDate(prisma, {
    billingStartDate: '2026-09-23',
    actorUsername: 'dev-prueba',
    actorRole: 'dev',
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent'
  });
  assert.equal(first.changed, true);
  assert.equal(prisma.auditEvents.length, 1);
  assert.equal(prisma.auditEvents[0].entityType, ATTENDANCE_BILLING_CONFIG_ENTITY_TYPE);
  assert.equal(prisma.auditEvents[0].entityId, ATTENDANCE_BILLING_CONFIG_ENTITY_ID);
  assert.equal(prisma.auditEvents[0].action, ATTENDANCE_BILLING_CONFIG_ACTION);
  assert.equal(prisma.auditEvents[0].metadata.billingStartDate, '2026-09-23');
  assert.equal(prisma.auditEvents[0].actorSource, 'attendance-admin-billing');

  const duplicate = await saveAttendanceBillingStartDate(prisma, {
    billingStartDate: '2026-09-23',
    actorUsername: 'dev-prueba',
    actorRole: 'dev'
  });
  assert.equal(duplicate.changed, false);
  assert.equal(prisma.auditEvents.length, 1);
});

test('solo DEV puede configurar el inicio del contador', () => {
  assert.equal(canConfigureAttendanceBilling({ session: { userRole: 'dev' } }), true);
  assert.equal(canConfigureAttendanceBilling({ userRole: 'dev' }), true);
  assert.equal(canConfigureAttendanceBilling({ session: { userRole: 'admin' } }), false);
  assert.equal(canConfigureAttendanceBilling({ session: { userRole: 'supervisor' } }), false);
  assert.equal(canConfigureAttendanceBilling({}), false);
});

test('cuenta una vez por auxiliar real si tuvo asistencia o ausencia confirmada', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'a1', workerId: 'w1', fullName: 'Ana Uno', documentNumber: 'TEST-1111',
      serviceDate: '2026-09-09', attendanceSession: { id: 's1' }
    }),
    assignment({
      id: 'a2', workerId: 'w1', fullName: 'Ana Uno', documentNumber: 'TEST-1111',
      serviceDate: '2026-09-10', attendanceSession: { id: 's2' }
    }),
    assignment({
      id: 'a3', workerId: 'w2', fullName: 'Bruno Dos', documentNumber: 'TEST-2222',
      serviceDate: '2026-09-12', status: 'CONFIRMED', attendanceSession: null
    })
  ]);

  const counter = await loadAttendanceBillingCounter(prisma, {
    billingStartDate: LEGACY_FULL_CYCLE_START,
    now: new Date('2026-09-20T15:00:00.000Z'),
    env: {}
  });

  assert.equal(counter.count, 2);
  assert.equal(counter.workers[0].fullName, 'Ana Uno');
  assert.equal(counter.workers[0].serviceDays, 2);
  assert.equal(counter.workers[0].reason, 'ATTENDANCE');
  assert.equal(counter.workers[1].reason, 'CONFIRMED_ABSENCE');
});

test('excluye perfiles de prueba y asignaciones no confirmadas sin uso de asistencia', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'test', workerId: 'wt', fullName: 'TEST Perfil', documentNumber: 'TEST-999',
      isTestProfile: true, serviceDate: '2026-09-10', attendanceSession: { id: 'st' }
    }),
    assignment({
      id: 'assigned', workerId: 'wa', fullName: 'Asignado', documentNumber: 'TEST-333',
      status: 'ASSIGNED', serviceDate: '2026-09-10'
    }),
    assignment({
      id: 'pending', workerId: 'wp', fullName: 'Pendiente', documentNumber: 'TEST-444',
      status: 'CONFIRMATION_PENDING', serviceDate: '2026-09-10'
    })
  ]);

  const counter = await loadAttendanceBillingCounter(prisma, {
    billingStartDate: LEGACY_FULL_CYCLE_START,
    now: new Date('2026-09-20T15:00:00.000Z'),
    env: {}
  });
  assert.equal(counter.count, 0);
});

test('una sesión de asistencia conserva el uso aunque el estado posterior ya no sea confirmado', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'cancelled-after-use', workerId: 'w5', fullName: 'Caso gestionado', documentNumber: 'TEST-555',
      status: 'CANCELLED', serviceDate: '2026-09-10', attendanceSession: { id: 's5' }
    })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    billingStartDate: LEGACY_FULL_CYCLE_START,
    now: new Date('2026-09-20T15:00:00.000Z'),
    env: {}
  });
  assert.equal(counter.count, 1);
  assert.equal(counter.workers[0].reason, 'ATTENDANCE');
});

test('deduplica por documento normalizado aun si existen dos workerId', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'a1', workerId: 'w10', fullName: 'Duplicado', documentNumber: 'TEST-1234567',
      serviceDate: '2026-09-10', attendanceSession: { id: 's10' }
    }),
    assignment({
      id: 'a2', workerId: 'w11', fullName: 'Duplicado', documentNumber: 'TEST 1234567',
      serviceDate: '2026-09-11', attendanceSession: { id: 's11' }
    })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    billingStartDate: LEGACY_FULL_CYCLE_START,
    now: new Date('2026-09-20T15:00:00.000Z'),
    env: {}
  });
  assert.equal(counter.count, 1);
  assert.equal(counter.workers[0].duplicateWorkerRecords, true);
});

test('no cuenta servicios futuros dentro del mismo ciclo', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'future', workerId: 'wf', fullName: 'Futuro', documentNumber: 'TEST-777',
      serviceDate: '2026-09-30', status: 'CONFIRMED'
    })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    billingStartDate: LEGACY_FULL_CYCLE_START,
    now: new Date('2026-09-20T15:00:00.000Z'),
    env: {}
  });
  assert.equal(counter.count, 0);
});

test('la UI ofrece selector DEV y explica que el rollover no borra historial', () => {
  const ui = fs.readFileSync(new URL('../src/public/attendance-admin-billing-counter.js', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');

  assert.match(ui, /type=\"date\" data-billing-start-input/);
  assert.match(ui, /Usar hoy/);
  assert.match(ui, /Guardar fecha oficial/);
  assert.match(ui, /START_DATE_ENDPOINT = '\/admin\/operaciones\/asistencia\/billing-counter\/start-date'/);
  assert.match(ui, /El día 8 el contador pasa automáticamente al nuevo ciclo/);
  assert.match(ui, /No se borran asistencias ni se reinicia el historial/);
  assert.match(ui, /window\.setInterval\(refreshCounter, AUTO_REFRESH_MS\)/);
  assert.doesNotMatch(ui, /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/);

  assert.match(route, /router\.post\('\/billing-counter\/start-date', formParser/);
  assert.match(route, /if \(!canConfigureAttendanceBilling\(req\)\)/);
  assert.match(route, /status\(403\).*solo está disponible para DEV/s);
});
