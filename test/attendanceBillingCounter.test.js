import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ATTENDANCE_BILLING_START_DATE,
  loadAttendanceBillingCounter,
  loadAttendanceBillingCounters,
  resolveAttendanceBillingCycle
} from '../src/modules/dispatch-attendance/application/attendanceBillingCounter.js';

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

function prismaWithAssignments(assignments) {
  const calls = [];
  return {
    calls,
    dispatchAssignment: {
      async findMany(args) {
        calls.push(args);
        return assignments;
      }
    }
  };
}

test('el ciclo facturable usa corte 8 a 7 en America/Bogota', () => {
  const cycle = resolveAttendanceBillingCycle({
    now: new Date('2026-10-20T15:00:00.000Z')
  });
  assert.equal(cycle.start, '2026-10-08');
  assert.equal(cycle.end, '2026-11-07');
  assert.equal(cycle.endExclusive, '2026-11-08');
  assert.equal(cycle.effectiveTo, '2026-10-20');
  assert.equal(cycle.status, 'OPEN');
});

test('antes del inicio contractual muestra el primer ciclo sin contar pruebas previas', async () => {
  assert.equal(DEFAULT_ATTENDANCE_BILLING_START_DATE, '2026-09-08');
  const prisma = prismaWithAssignments([
    assignment({
      id: 'a1', workerId: 'w1', fullName: 'Auxiliar previo', documentNumber: '100',
      serviceDate: '2026-08-24', attendanceSession: { id: 's1' }
    })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    now: new Date('2026-08-24T20:00:00.000Z')
  });
  assert.equal(counter.start, '2026-09-08');
  assert.equal(counter.status, 'UPCOMING');
  assert.equal(counter.count, 0);
  assert.equal(prisma.calls.length, 0);
});

test('cuenta una vez por auxiliar real si tuvo asistencia o ausencia confirmada', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'a1', workerId: 'w1', fullName: 'Ana Uno', documentNumber: '1.111',
      serviceDate: '2026-09-09', attendanceSession: { id: 's1' }
    }),
    assignment({
      id: 'a2', workerId: 'w1', fullName: 'Ana Uno', documentNumber: '1111',
      serviceDate: '2026-09-10', attendanceSession: { id: 's2' }
    }),
    assignment({
      id: 'a3', workerId: 'w2', fullName: 'Bruno Dos', documentNumber: '2222',
      serviceDate: '2026-09-12', status: 'CONFIRMED', attendanceSession: null
    })
  ]);

  const counter = await loadAttendanceBillingCounter(prisma, {
    now: new Date('2026-09-20T15:00:00.000Z')
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
      id: 'test', workerId: 'wt', fullName: 'TEST Perfil', documentNumber: '999',
      isTestProfile: true, serviceDate: '2026-09-10', attendanceSession: { id: 'st' }
    }),
    assignment({
      id: 'assigned', workerId: 'wa', fullName: 'Asignado', documentNumber: '333',
      status: 'ASSIGNED', serviceDate: '2026-09-10'
    }),
    assignment({
      id: 'pending', workerId: 'wp', fullName: 'Pendiente', documentNumber: '444',
      status: 'CONFIRMATION_PENDING', serviceDate: '2026-09-10'
    })
  ]);

  const counter = await loadAttendanceBillingCounter(prisma, {
    now: new Date('2026-09-20T15:00:00.000Z')
  });
  assert.equal(counter.count, 0);
});

test('una sesión de asistencia conserva el uso aunque el estado posterior ya no sea confirmado', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'cancelled-after-use', workerId: 'w5', fullName: 'Caso gestionado', documentNumber: '555',
      status: 'CANCELLED', serviceDate: '2026-09-10', attendanceSession: { id: 's5' }
    })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    now: new Date('2026-09-20T15:00:00.000Z')
  });
  assert.equal(counter.count, 1);
  assert.equal(counter.workers[0].reason, 'ATTENDANCE');
});

test('deduplica por documento normalizado aun si existen dos workerId', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'a1', workerId: 'w10', fullName: 'Duplicado', documentNumber: '1.234.567',
      serviceDate: '2026-09-10', attendanceSession: { id: 's10' }
    }),
    assignment({
      id: 'a2', workerId: 'w11', fullName: 'Duplicado', documentNumber: '1234567',
      serviceDate: '2026-09-11', attendanceSession: { id: 's11' }
    })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    now: new Date('2026-09-20T15:00:00.000Z')
  });
  assert.equal(counter.count, 1);
  assert.equal(counter.workers[0].duplicateWorkerRecords, true);
});

test('no cuenta servicios futuros dentro del mismo ciclo', async () => {
  const prisma = prismaWithAssignments([
    assignment({
      id: 'future', workerId: 'wf', fullName: 'Futuro', documentNumber: '777',
      serviceDate: '2026-09-30', status: 'CONFIRMED'
    })
  ]);
  const counter = await loadAttendanceBillingCounter(prisma, {
    now: new Date('2026-09-20T15:00:00.000Z')
  });
  assert.equal(counter.count, 0);
});

test('entrega ciclo actual y anterior para poder consultar el corte recién cerrado', async () => {
  const prisma = prismaWithAssignments([]);
  const counters = await loadAttendanceBillingCounters(prisma, {
    now: new Date('2026-10-08T15:00:00.000Z')
  });
  assert.equal(counters.current.start, '2026-10-08');
  assert.equal(counters.previous.start, '2026-09-08');
  assert.equal(counters.previous.end, '2026-10-07');
  assert.equal(counters.previous.status, 'CLOSED');
});
