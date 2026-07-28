import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import {
  WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
  workerPortalRouter
} from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const SESSION_TOKEN = 'B'.repeat(43);
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = new Date('2026-07-25T22:00:00.000Z');

function cookieHeader() {
  return `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${SESSION_TOKEN}; ${WORKER_PORTAL_INSTALLATION_COOKIE_NAME}=${INSTALLATION_ID}`;
}

function departureForm() {
  const form = new FormData();
  form.set('idempotencyKey', 'departure_test_123456789');
  form.set('latitude', '4.7111');
  form.set('longitude', '-74.072');
  form.set('accuracyMeters', '12');
  form.set('clientCapturedAt', NOW.toISOString());
  form.set('captureMode', 'ONLINE_WEB');
  form.set('persistentStorageAvailable', 'true');
  form.set('photoConsent', 'true');
  form.set('selfie', new Blob([Buffer.from('jpeg')], { type: 'image/jpeg' }), 'salida.jpg');
  return form;
}

async function withServer(options, callback) {
  const app = express();
  app.use('/operaciones/portal', workerPortalRouter({}, {
    repository: {},
    installationPepper: 'p'.repeat(32),
    nowFn: () => NOW,
    nonceBytesFn: (size) => Buffer.alloc(size, 3),
    resolveSessionFn: async () => ({
      workerId: 'worker-1',
      deviceId: 'device-1',
      sessionId: 'session-1',
      expiresAt: new Date('2026-08-01T22:00:00Z')
    }),
    loadAssignmentsFn: async () => [],
    ...options
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ ok: false, error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback(origin);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('registra salida usando el auxiliar resuelto por la sesión', async () => {
  let observedAssignmentInput;
  let observedEvidenceInput;
  let observedDepartureInput;
  await withServer({
    loadAssignmentForDepartureFn: async (_prisma, input) => {
      observedAssignmentInput = input;
      return {
        id: 'assignment-1',
        attendanceEnabled: true,
        arrivalReported: true,
        departureReported: false,
        canRegisterDeparture: true,
        breakOpen: false,
        photoRequired: true
      };
    },
    storeDepartureEvidenceFn: async (input) => {
      observedEvidenceInput = input;
      return {
        storageKey: 'attendance/worker-1/assignment-1/departure/photo.jpg',
        mimeType: 'image/jpeg',
        created: true
      };
    },
    registerDepartureFn: async (_prisma, input) => {
      observedDepartureInput = input;
      return {
        recorded: true,
        replayed: false,
        attendanceSession: { attendanceStatus: 'COMPLETED' },
        validation: {
          validationStatus: 'AUTO_VALIDATED',
          workedMinutes: 480,
          grossWorkedMinutes: 540,
          unpaidBreakMinutesDeducted: 60,
          ordinaryWorkedMinutes: 420,
          overtimeMinutes: 60,
          riskFlags: []
        }
      };
    }
  }, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-1/salida`, {
      method: 'POST',
      headers: { Cookie: cookieHeader(), 'X-Requested-With': 'worker-portal' },
      body: departureForm()
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.markType, 'DEPARTURE');
    assert.equal(payload.workedMinutes, 480);
  });
  assert.equal(observedAssignmentInput.workerId, 'worker-1');
  assert.equal(observedEvidenceInput.workerId, 'worker-1');
  assert.equal(observedDepartureInput.expectedWorkerId, 'worker-1');
  assert.match(observedDepartureInput.installationIdHash, /^[a-f0-9]{64}$/);
});

test('permite registrar salida cuando el almuerzo quedó pendiente y la autoridad aplicará penalización', async () => {
  let registerCalls = 0;
  await withServer({
    loadAssignmentForDepartureFn: async () => ({
      id: 'assignment-1',
      attendanceEnabled: true,
      arrivalReported: true,
      departureReported: false,
      breakPending: true,
      breakOpen: false,
      canRegisterDeparture: true,
      photoRequired: false
    }),
    storeDepartureEvidenceFn: async () => ({ storageKey: null, mimeType: null, created: false }),
    registerDepartureFn: async () => {
      registerCalls += 1;
      return {
        recorded: true,
        replayed: false,
        attendanceSession: { attendanceStatus: 'COMPLETED' },
        validation: {
          validationStatus: 'AUTO_VALIDATED',
          workedMinutes: 450,
          unpaidBreakMinutesDeducted: 90,
          breakStatus: 'INCOMPLETE',
          ordinaryWorkedMinutes: 420,
          overtimeMinutes: 30,
          riskFlags: []
        }
      };
    }
  }, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-1/salida`, {
      method: 'POST',
      headers: { Cookie: cookieHeader(), 'X-Requested-With': 'worker-portal' },
      body: departureForm()
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });
  assert.equal(registerCalls, 1);
});

test('bloquea salida cuando no existe llegada', async () => {
  let registerCalls = 0;
  await withServer({
    loadAssignmentForDepartureFn: async () => ({
      id: 'assignment-1',
      attendanceEnabled: true,
      arrivalReported: false,
      departureReported: false,
      photoRequired: false
    }),
    registerDepartureFn: async () => { registerCalls += 1; }
  }, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-1/salida`, {
      method: 'POST',
      headers: { Cookie: cookieHeader(), 'X-Requested-With': 'worker-portal' },
      body: departureForm()
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { ok: false, error: 'departure_arrival_required' });
  });
  assert.equal(registerCalls, 0);
});

test('bloquea una segunda salida antes de almacenar otra evidencia', async () => {
  let evidenceCalls = 0;
  await withServer({
    loadAssignmentForDepartureFn: async () => ({
      id: 'assignment-1',
      attendanceEnabled: true,
      arrivalReported: true,
      departureReported: true,
      photoRequired: true
    }),
    storeDepartureEvidenceFn: async () => { evidenceCalls += 1; }
  }, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-1/salida`, {
      method: 'POST',
      headers: { Cookie: cookieHeader(), 'X-Requested-With': 'worker-portal' },
      body: departureForm()
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { ok: false, error: 'departure_already_registered' });
  });
  assert.equal(evidenceCalls, 0);
});