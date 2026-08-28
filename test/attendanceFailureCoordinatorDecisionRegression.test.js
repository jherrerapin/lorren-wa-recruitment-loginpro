import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  loadAttendanceAdminBoard,
  resolveAttendanceFailureDecision
} from '../src/modules/dispatch-attendance/application/adminAttendance.js';
import {
  buildDispatchAttendanceFailureDecisionPayload
} from '../src/services/dispatchWhatsappCloudClient.js';
import {
  buildDispatchAttendanceFailureAdminAlertText,
  resolveDispatchAttendanceFailureCoordinatorDecision
} from '../src/services/dispatchWhatsappAdminAlerts.js';

const FAILURE_ID = `attendance_failure_${'a'.repeat(48)}`;
const ASSIGNMENT_ID = 'assignment-test-1';
const COORDINATOR_PHONE = '573000000111';
const ATTEMPTED_AT = new Date('2026-08-28T15:43:00.000Z');

function failureEvent(overrides = {}) {
  return {
    id: FAILURE_ID,
    entityType: 'DISPATCH_ATTENDANCE_MARK_FAILURE',
    entityId: ASSIGNMENT_ID,
    action: 'MARK_ATTEMPT_FAILED',
    createdAt: new Date('2026-08-28T15:43:01.000Z'),
    metadata: {
      assignmentId: ASSIGNMENT_ID,
      attemptId: 'attempt_test_123456',
      markType: 'ARRIVAL',
      failureCode: 'outside_operation_range',
      phaseLabel: 'Ubicación',
      descriptionEs: 'La ubicación estaba fuera del rango permitido para marcar.',
      sourceLabel: 'Portal del auxiliar',
      origin: 'SERVER_RESPONSE',
      occurredAt: ATTEMPTED_AT.toISOString(),
      latitude: 4.62001,
      longitude: -74.10001,
      accuracyMeters: 13,
      ...overrides
    }
  };
}

function decisionPrisma({ event = failureEvent() } = {}) {
  const events = new Map([[event.id, structuredClone(event)]]);
  const assignment = {
    id: ASSIGNMENT_ID,
    createdByUsername: 'coordinador-prueba'
  };
  return {
    events,
    api: {
      devAuditEvent: {
        async findUnique({ where }) {
          return events.get(where.id) || null;
        },
        async create({ data }) {
          if (events.has(data.id)) {
            const error = new Error('duplicate');
            error.code = 'P2002';
            throw error;
          }
          const row = { ...structuredClone(data), createdAt: data.createdAt || new Date() };
          events.set(data.id, row);
          return row;
        },
        async update({ where, data }) {
          const current = events.get(where.id);
          if (!current) throw new Error('audit_event_missing');
          const next = { ...current, ...structuredClone(data) };
          events.set(where.id, next);
          return next;
        }
      },
      dispatchAssignment: {
        async findUnique({ where }) {
          return where.id === ASSIGNMENT_ID ? assignment : null;
        }
      },
      appUser: {
        async findUnique({ where }) {
          if (where.username !== 'coordinador-prueba') return null;
          return {
            id: 'user-test-1',
            username: 'coordinador-prueba',
            isActive: true,
            dispatchAlertPhone: COORDINATOR_PHONE
          };
        }
      }
    }
  };
}

function attendanceWriter(writes) {
  return async (_prisma, input) => {
    writes.push(input);
    return { id: 'attendance-session-test-1' };
  };
}

function boardAssignment() {
  return {
    id: ASSIGNMENT_ID,
    workerId: 'worker-test-1',
    serviceRequestId: 'request-test-1',
    status: 'CONFIRMED',
    worker: {
      id: 'worker-test-1',
      fullName: 'Auxiliar Prueba',
      documentType: 'CC',
      documentNumber: 'TEST-0001',
      phone: 'TEST-PHONE'
    },
    serviceRequest: {
      id: 'request-test-1',
      serviceDate: new Date('2026-08-28T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      clientName: 'Cliente de prueba',
      operationPointName: 'Operación de prueba',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
      operationPoint: {
        id: 'operation-test-1',
        name: 'Operación de prueba',
        cityName: 'Bogotá',
        address: 'Dirección de prueba',
        attendanceEnabled: true,
        attendanceLatitude: 4.7111,
        attendanceLongitude: -74.0721,
        geofenceRadiusMeters: 100,
        maxLocationAccuracyMeters: 50,
        absenceGraceMinutes: 15,
        manualAttendanceAllowed: true
      }
    },
    attendanceSession: null
  };
}

function boardPrisma({ failure = failureEvent(), decisionEvent = null } = {}) {
  const assignment = boardAssignment();
  return {
    dispatchAssignment: {
      async findMany() { return [assignment]; },
      async findUnique() { return assignment; }
    },
    dispatchAttendanceSession: {
      async findUnique() { return null; },
      async create({ data }) { return { id: 'session-created', ...data }; },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceMark: {
      async findFirst() { return null; },
      async create({ data }) { return { id: 'mark-created', ...data }; },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceReview: {
      async create({ data }) { return { id: 'review-created', ...data }; }
    },
    devAuditEvent: {
      async findMany({ where }) {
        if (where?.entityType === 'DISPATCH_ATTENDANCE_MARK_FAILURE') return [failure];
        if (where?.entityType === 'DISPATCH_ATTENDANCE_MARK_FAILURE_DECISION') return decisionEvent ? [decisionEvent] : [];
        return [];
      }
    },
    async $transaction(callback) { return callback(this); }
  };
}

test('la alerta usa dos botones cerrados para aceptar o rechazar el intento', () => {
  const payload = buildDispatchAttendanceFailureDecisionPayload({
    phone: COORDINATOR_PHONE,
    failureEventId: FAILURE_ID,
    text: 'Marcación no completada de prueba.'
  });

  assert.equal(payload.type, 'interactive');
  assert.deepEqual(
    payload.interactive.action.buttons.map((button) => button.reply.title),
    ['ACEPTAR MARCACIÓN', 'RECHAZAR']
  );
  assert.deepEqual(
    payload.interactive.action.buttons.map((button) => button.reply.id),
    [`dispatch_attendance_accept:${FAILURE_ID}`, `dispatch_attendance_reject:${FAILURE_ID}`]
  );
});

test('fuera de geocerca muestra el punto GPS real del intento al coordinador', () => {
  const event = failureEvent();
  const text = buildDispatchAttendanceFailureAdminAlertText({
    failureEvent: event,
    assignment: {
      worker: { fullName: 'Auxiliar Prueba' },
      serviceRequest: { operationPointName: 'Operación Prueba' }
    },
    failureContext: {
      markType: 'ARRIVAL',
      occurredAt: ATTEMPTED_AT,
      latitude: event.metadata.latitude,
      longitude: event.metadata.longitude,
      accuracyMeters: event.metadata.accuracyMeters
    }
  });

  assert.match(text, /Auxiliar Prueba/);
  assert.match(text, /La ubicación estaba fuera del rango permitido para marcar\./);
  assert.match(text, /https:\/\/www\.google\.com\/maps\?q=4\.62001,-74\.10001/);
  assert.match(text, /Precisión reportada: 13 m\./);
});

test('aceptar por WhatsApp registra una sola vez la entrada con la hora original del intento', async () => {
  const store = decisionPrisma();
  const writes = [];
  const registerManualAttendanceFn = attendanceWriter(writes);

  const first = await resolveDispatchAttendanceFailureCoordinatorDecision({
    scope: 'operational',
    failureEventId: FAILURE_ID,
    decision: 'ACCEPT',
    coordinatorPhone: COORDINATOR_PHONE,
    decidedAt: new Date('2026-08-28T15:50:00.000Z'),
    prismaClient: store.api,
    registerManualAttendanceFn
  });

  assert.equal(first.handled, true);
  assert.equal(first.status, 'ACCEPTED');
  assert.equal(first.duplicate, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].assignmentId, ASSIGNMENT_ID);
  assert.equal(writes[0].arrivalReportedAt, ATTEMPTED_AT.toISOString());
  assert.equal(writes[0].actorRole, 'coordinator-whatsapp');

  const duplicate = await resolveDispatchAttendanceFailureCoordinatorDecision({
    scope: 'operational',
    failureEventId: FAILURE_ID,
    decision: 'ACCEPT',
    coordinatorPhone: COORDINATOR_PHONE,
    decidedAt: new Date('2026-08-28T15:51:00.000Z'),
    prismaClient: store.api,
    registerManualAttendanceFn
  });

  assert.equal(duplicate.handled, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, 'ACCEPTED');
  assert.equal(writes.length, 1);
  const decision = [...store.events.values()].find((item) => item.entityType === 'DISPATCH_ATTENDANCE_MARK_FAILURE_DECISION');
  assert.equal(decision.metadata.status, 'ACCEPTED');
  assert.equal(decision.metadata.attemptedAt, ATTEMPTED_AT.toISOString());
  assert.equal(decision.actorSource, 'dispatch-whatsapp');
});

test('rechazar por WhatsApp deja decisión auditada y no crea ninguna marcación', async () => {
  const store = decisionPrisma();
  let writerCalled = false;
  const result = await resolveDispatchAttendanceFailureCoordinatorDecision({
    scope: 'operational',
    failureEventId: FAILURE_ID,
    decision: 'REJECT',
    coordinatorPhone: COORDINATOR_PHONE,
    decidedAt: new Date('2026-08-28T15:50:00.000Z'),
    prismaClient: store.api,
    registerManualAttendanceFn: async () => {
      writerCalled = true;
      throw new Error('writer_must_not_run');
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'REJECTED');
  assert.equal(writerCalled, false);
  const decision = [...store.events.values()].find((item) => item.entityType === 'DISPATCH_ATTENDANCE_MARK_FAILURE_DECISION');
  assert.equal(decision.metadata.status, 'REJECTED');
});

test('un WhatsApp distinto al configurado no puede decidir la marcación', async () => {
  const store = decisionPrisma();
  let writerCalled = false;
  const result = await resolveDispatchAttendanceFailureCoordinatorDecision({
    scope: 'operational',
    failureEventId: FAILURE_ID,
    decision: 'ACCEPT',
    coordinatorPhone: '573000000222',
    decidedAt: new Date('2026-08-28T15:50:00.000Z'),
    prismaClient: store.api,
    registerManualAttendanceFn: async () => {
      writerCalled = true;
      return { id: 'unexpected' };
    }
  });

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'coordinator_unauthorized');
  assert.equal(writerCalled, false);
  assert.equal([...store.events.values()].some((item) => item.entityType === 'DISPATCH_ATTENDANCE_MARK_FAILURE_DECISION'), false);
});

test('el dashboard acepta el intento con el actor autenticado y la misma hora original', async () => {
  const store = decisionPrisma();
  const writes = [];
  const result = await resolveAttendanceFailureDecision(store.api, {
    failureEventId: FAILURE_ID,
    decision: 'ACCEPT',
    actorUserId: 'dashboard-user-test-1',
    actorUsername: 'coordinador-panel',
    actorRole: 'admin',
    actorSource: 'attendance-dashboard',
    writerActorRole: 'attendance-dashboard',
    decidedAt: new Date('2026-08-28T15:52:00.000Z'),
    registerManualAttendanceFn: attendanceWriter(writes)
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'ACCEPTED');
  assert.equal(result.duplicate, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].arrivalReportedAt, ATTEMPTED_AT.toISOString());
  assert.equal(writes[0].actorUsername, 'coordinador-panel');
  assert.equal(writes[0].actorRole, 'attendance-dashboard');
  const decision = [...store.events.values()].find((item) => item.entityType === 'DISPATCH_ATTENDANCE_MARK_FAILURE_DECISION');
  assert.equal(decision.actorUsername, 'coordinador-panel');
  assert.equal(decision.actorRole, 'admin');
  assert.equal(decision.actorSource, 'attendance-dashboard');
});

test('dashboard y WhatsApp comparten una sola decisión terminal en ambos órdenes', async () => {
  const dashboardFirst = decisionPrisma();
  const dashboardWrites = [];
  await resolveAttendanceFailureDecision(dashboardFirst.api, {
    failureEventId: FAILURE_ID,
    decision: 'ACCEPT',
    actorUsername: 'coordinador-panel',
    actorRole: 'admin',
    actorSource: 'attendance-dashboard',
    writerActorRole: 'attendance-dashboard',
    decidedAt: new Date('2026-08-28T15:52:00.000Z'),
    registerManualAttendanceFn: attendanceWriter(dashboardWrites)
  });
  const whatsappAfter = await resolveDispatchAttendanceFailureCoordinatorDecision({
    failureEventId: FAILURE_ID,
    decision: 'REJECT',
    coordinatorPhone: COORDINATOR_PHONE,
    decidedAt: new Date('2026-08-28T15:53:00.000Z'),
    prismaClient: dashboardFirst.api,
    registerManualAttendanceFn: attendanceWriter(dashboardWrites)
  });
  assert.equal(whatsappAfter.duplicate, true);
  assert.equal(whatsappAfter.status, 'ACCEPTED');
  assert.equal(dashboardWrites.length, 1);

  const whatsappFirst = decisionPrisma();
  const whatsappWrites = [];
  await resolveDispatchAttendanceFailureCoordinatorDecision({
    failureEventId: FAILURE_ID,
    decision: 'ACCEPT',
    coordinatorPhone: COORDINATOR_PHONE,
    decidedAt: new Date('2026-08-28T15:54:00.000Z'),
    prismaClient: whatsappFirst.api,
    registerManualAttendanceFn: attendanceWriter(whatsappWrites)
  });
  const dashboardAfter = await resolveAttendanceFailureDecision(whatsappFirst.api, {
    failureEventId: FAILURE_ID,
    decision: 'REJECT',
    actorUsername: 'coordinador-panel',
    actorRole: 'admin',
    actorSource: 'attendance-dashboard',
    writerActorRole: 'attendance-dashboard',
    decidedAt: new Date('2026-08-28T15:55:00.000Z'),
    registerManualAttendanceFn: attendanceWriter(whatsappWrites)
  });
  assert.equal(dashboardAfter.duplicate, true);
  assert.equal(dashboardAfter.status, 'ACCEPTED');
  assert.equal(whatsappWrites.length, 1);
});

test('al recargar Asistencia el intento conserva la decisión terminal y su canal', async () => {
  const decisionEvent = {
    id: `attendance_decision_${'b'.repeat(48)}`,
    entityType: 'DISPATCH_ATTENDANCE_MARK_FAILURE_DECISION',
    entityId: FAILURE_ID,
    action: 'COORDINATOR_DECISION',
    actorUsername: 'coordinador-panel',
    actorRole: 'admin',
    actorSource: 'attendance-dashboard',
    createdAt: new Date('2026-08-28T15:52:00.000Z'),
    metadata: {
      failureEventId: FAILURE_ID,
      assignmentId: ASSIGNMENT_ID,
      markType: 'ARRIVAL',
      attemptedAt: ATTEMPTED_AT.toISOString(),
      requestedDecision: 'ACCEPT',
      status: 'ACCEPTED',
      resolvedAt: '2026-08-28T15:52:00.000Z'
    }
  };
  const board = await loadAttendanceAdminBoard(boardPrisma({ decisionEvent }), {
    from: '2026-08-28',
    to: '2026-08-28',
    now: new Date('2026-08-28T16:00:00.000Z')
  });

  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].failedMarkAttemptCount, 1);
  const attempt = board.rows[0].failedMarkAttempts[0];
  assert.equal(attempt.failureEventId, FAILURE_ID);
  assert.equal(attempt.decisionStatus, 'ACCEPTED');
  assert.equal(attempt.decisionActorUsername, 'coordinador-panel');
  assert.equal(attempt.decisionActorSource, 'attendance-dashboard');
  assert.match(attempt.decisionResolvedAtLabel, /28/);
});

test('la decisión vive en Asistencia, ambos canales delegan y webhook sigue sin reglas nuevas', () => {
  const attendance = fs.readFileSync(new URL('../src/modules/dispatch-attendance/application/adminAttendance.js', import.meta.url), 'utf8');
  const alerts = fs.readFileSync(new URL('../src/services/dispatchWhatsappAdminAlerts.js', import.meta.url), 'utf8');
  const inbound = fs.readFileSync(new URL('../src/services/dispatchWhatsappWebhookService.js', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  const adminRoute = fs.readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
  const view = fs.readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');
  const portal = fs.readFileSync(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8');

  assert.match(attendance, /export async function resolveAttendanceFailureDecision/);
  assert.match(attendance, /registerManualAttendanceFn\(prisma/);
  assert.match(attendance, /failureEventId:\s*event\.id/);
  assert.match(attendance, /decisionStatus/);
  assert.doesNotMatch(attendance, /dispatchAttendanceMark\.create\([^\n]*failure/i);
  assert.match(alerts, /resolveAttendanceFailureDecision/);
  assert.doesNotMatch(alerts, /registerManualAttendanceFn\(prismaClient/);
  assert.match(inbound, /dispatch_attendance_\(accept\|reject\)/);
  assert.match(inbound, /resolveDispatchAttendanceFailureCoordinatorDecision/);
  assert.doesNotMatch(route, /dispatch_attendance_accept|dispatch_attendance_reject|ATTENDANCE_MARK_FAILURE_DECISION/);
  assert.match(adminRoute, /failures\/:failureEventId\/decision/);
  assert.match(adminRoute, /resolveAttendanceFailureDecision/);
  assert.match(view, /Aceptar marcación/);
  assert.match(view, /name="decision" value="ACCEPT"/);
  assert.match(view, /name="decision" value="REJECT"/);
  assert.match(portal, /sendDispatchAttendanceFailureAdminAlert/);
  assert.match(portal, /latitude:\s*finiteNumber\(req\.body\?\.latitude/);
  assert.match(portal, /longitude:\s*finiteNumber\(req\.body\?\.longitude/);
});
