import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import express from 'express';
import {
  attendanceMarkFailureDefinition,
  auditAttendanceMarkFailure,
  workerPortalRouter
} from '../src/routes/workerPortal.js';
import { loadAttendanceAdminBoard } from '../src/modules/dispatch-attendance/application/adminAttendance.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const NOW = new Date('2026-08-28T13:00:00.000Z');
const SESSION_TOKEN = 'T'.repeat(43);
const WORKER_ID = 'worker-test-1';
const ASSIGNMENT_ID = 'assignment-test-1';
const OTHER_ASSIGNMENT_ID = 'assignment-test-other';

function operationPoint() {
  return {
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
  };
}

function serviceRequest() {
  return {
    id: 'request-test-1',
    serviceDate: new Date('2026-08-28T00:00:00.000Z'),
    startTime: '08:00',
    endTime: '17:00',
    clientName: 'Cliente de prueba',
    operationPointName: 'Operación de prueba',
    cityName: 'Bogotá',
    address: 'Dirección de prueba',
    operationPoint: operationPoint()
  };
}

function assignment(id = ASSIGNMENT_ID) {
  return {
    id,
    workerId: WORKER_ID,
    serviceRequestId: 'request-test-1',
    status: 'CONFIRMED',
    worker: {
      id: WORKER_ID,
      fullName: 'Auxiliar Prueba',
      documentType: 'CC',
      documentNumber: 'TEST-0001',
      phone: 'TEST-PHONE'
    },
    serviceRequest: serviceRequest(),
    attendanceSession: null
  };
}

function requestHeaders() {
  return {
    Cookie: `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${SESSION_TOKEN}`,
    'Content-Type': 'application/json',
    'X-Requested-With': 'worker-portal'
  };
}

async function withPortalServer({ ownedAssignmentId = ASSIGNMENT_ID } = {}, callback) {
  const audits = [];
  const prisma = {
    dispatchAssignment: {
      async findFirst({ where }) {
        if (where?.id !== ownedAssignmentId || where?.workerId !== WORKER_ID) return null;
        return assignment(ownedAssignmentId);
      }
    },
    devAuditEvent: {
      async findFirst() { return null; }
    }
  };
  const app = express();
  app.use('/operaciones/portal', workerPortalRouter(prisma, {
    repository: {},
    nowFn: () => NOW,
    resolveSessionFn: async () => ({
      workerId: WORKER_ID,
      deviceId: 'device-test-1',
      sessionId: 'session-test-1',
      expiresAt: new Date('2026-09-01T13:00:00.000Z')
    }),
    loadAssignmentsFn: async () => [],
    getEnrollmentFn: async () => ({ enrolled: true, descriptor: [1], evidenceVersion: 2 }),
    auditMarkFailureFn: async (input) => { audits.push(input); }
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ ok: false, error: error.message }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback(origin, audits);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function adminPrisma(failureEvents = []) {
  return {
    dispatchAssignment: {
      async findMany() { return [assignment()]; },
      async findUnique() { return assignment(); }
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
      async findMany() { return failureEvents; }
    },
    async $transaction(callback) { return callback(this); }
  };
}

test('el catálogo expone causas concretas en español y no acepta códigos inventados', () => {
  const timeout = attendanceMarkFailureDefinition('client_location_timeout');
  assert.equal(timeout.clientReportable, true);
  assert.equal(timeout.phaseLabel, 'Ubicación');
  assert.equal(timeout.descriptionEs, 'El GPS agotó 20 segundos sin entregar una ubicación para la marcación.');
  assert.equal(attendanceMarkFailureDefinition('error_inventado_por_auxiliar'), null);
});

test('la auditoría persiste la descripción definida por servidor y no texto libre del cliente', async () => {
  const writes = [];
  const prisma = {
    devAuditEvent: {
      async upsert(input) {
        writes.push(input);
        return { id: input.where.id, ...input.create };
      }
    }
  };

  await auditAttendanceMarkFailure(prisma, {
    assignmentId: ASSIGNMENT_ID,
    markType: 'ARRIVAL',
    errorCode: 'client_location_timeout',
    attemptId: 'attempt_test_123456',
    occurredAt: NOW,
    recordedAt: NOW,
    origin: 'CLIENT_PREFLIGHT',
    sourceLabel: 'Aplicación Android',
    description: 'Texto libre que no debe persistirse'
  });

  assert.equal(writes.length, 1);
  const metadata = writes[0].create.metadata;
  assert.equal(metadata.descriptionEs, 'El GPS agotó 20 segundos sin entregar una ubicación para la marcación.');
  assert.equal(metadata.phaseLabel, 'Ubicación');
  assert.equal(metadata.sourceLabel, 'Aplicación Android');
  assert.equal(metadata.failureCode, 'client_location_timeout');
  assert.equal(Object.hasOwn(metadata, 'description'), false);
  assert.equal(Object.hasOwn(metadata, 'message'), false);
});

test('acepta un fallo previo al envío solo para una asignación de la sesión actual', async () => {
  await withPortalServer({}, async (origin, audits) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/${ASSIGNMENT_ID}/intentos-fallidos`, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({
        markType: 'ARRIVAL',
        clientAttemptId: 'attempt_test_123456',
        errorCode: 'client_location_timeout',
        occurredAt: NOW.toISOString(),
        description: 'El cliente no puede decidir la descripción visible'
      })
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].assignmentId, ASSIGNMENT_ID);
    assert.equal(audits[0].errorCode, 'client_location_timeout');
    assert.equal(audits[0].markType, 'ARRIVAL');
    assert.equal(Object.hasOwn(audits[0], 'description'), false);
  });
});

test('rechaza un reporte para otra asignación y no genera evidencia técnica falsa', async () => {
  await withPortalServer({}, async (origin, audits) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/${OTHER_ASSIGNMENT_ID}/intentos-fallidos`, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({
        markType: 'ARRIVAL',
        clientAttemptId: 'attempt_test_654321',
        errorCode: 'client_camera_unavailable',
        occurredAt: NOW.toISOString()
      })
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'assignment_not_available');
    assert.equal(audits.length, 0);
  });
});

test('un rechazo real del servidor conserva la respuesta y deja el intento auditado', async () => {
  await withPortalServer({}, async (origin, audits) => {
    const response = await fetch(`${origin}/operaciones/portal/biometria/desafio`, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({
        assignmentId: ASSIGNMENT_ID,
        markType: 'ARRIVAL',
        idempotencyKey: 'attempt_server_123456789',
        latitude: 6.2442,
        longitude: -75.5812,
        accuracyMeters: 12,
        clientCapturedAt: NOW.toISOString()
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.error, 'outside_operation_range');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].assignmentId, ASSIGNMENT_ID);
    assert.equal(audits[0].errorCode, 'outside_operation_range');
    assert.equal(audits[0].origin, 'SERVER_RESPONSE');
  });
});

test('el panel de asistencia proyecta solo la explicación española guardada en auditoría', async () => {
  const prisma = adminPrisma([{
    id: 'failure-test-1',
    entityType: 'DISPATCH_ATTENDANCE_MARK_FAILURE',
    entityId: ASSIGNMENT_ID,
    action: 'MARK_ATTEMPT_FAILED',
    createdAt: NOW,
    metadata: {
      assignmentId: ASSIGNMENT_ID,
      attemptId: 'attempt_test_123456',
      markType: 'ARRIVAL',
      failureCode: 'client_location_timeout',
      phaseLabel: 'Ubicación',
      descriptionEs: 'El GPS agotó 20 segundos sin entregar una ubicación para la marcación.',
      sourceLabel: 'Aplicación Android',
      origin: 'CLIENT_PREFLIGHT',
      occurredAt: NOW.toISOString()
    }
  }]);

  const board = await loadAttendanceAdminBoard(prisma, {
    from: '2026-08-28',
    to: '2026-08-28',
    now: NOW
  });
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].failedMarkAttemptCount, 1);
  assert.equal(board.rows[0].failedMarkAttempts[0].markLabel, 'Entrada');
  assert.equal(board.rows[0].failedMarkAttempts[0].phaseLabel, 'Ubicación');
  assert.equal(board.rows[0].failedMarkAttempts[0].description, 'El GPS agotó 20 segundos sin entregar una ubicación para la marcación.');
  assert.equal(Object.hasOwn(board.rows[0].failedMarkAttempts[0], 'failureCode'), false);
});

test('el flujo cliente encola fallos conocidos y la vista no expone códigos técnicos', () => {
  const flowSource = fs.readFileSync(new URL('../src/public/worker-portal-biometric-flow.js', import.meta.url), 'utf8');
  const viewSource = fs.readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');

  assert.match(flowSource, /ATTENDANCE_FAILURE_QUEUE_KEY/);
  assert.match(flowSource, /client_location_timeout/);
  assert.match(flowSource, /client_network_request_failed/);
  assert.match(flowSource, /intentos-fallidos/);
  assert.match(flowSource, /flushAttendanceFailureQueue/);
  assert.match(flowSource, /body:\s*JSON\.stringify\(\{\s*markType:\s*record\.markType,\s*clientAttemptId:\s*record\.clientAttemptId,\s*errorCode:\s*record\.errorCode,\s*occurredAt:\s*record\.occurredAt/s);
  assert.doesNotMatch(flowSource, /description:\s*error/);

  assert.match(viewSource, /Intentos fallidos registrados:/);
  assert.match(viewSource, /attempt\.description/);
  assert.doesNotMatch(viewSource, /attempt\.failureCode/);
});
