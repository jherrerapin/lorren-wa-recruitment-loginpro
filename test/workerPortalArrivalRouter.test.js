import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import {
  WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
  redactWorkerPortalActivationUrlForLogging,
  workerPortalRouter
} from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const SESSION_TOKEN = 'B'.repeat(43);
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = new Date('2026-07-22T13:00:00.000Z');

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
      expiresAt: new Date('2026-07-29T13:00:00.000Z')
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

function cookieHeader() {
  return `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${SESSION_TOKEN}; ${WORKER_PORTAL_INSTALLATION_COOKIE_NAME}=${INSTALLATION_ID}`;
}

function arrivalForm({ includePhoto = true } = {}) {
  const form = new FormData();
  form.set('idempotencyKey', 'arrival_test_123456789');
  form.set('latitude', '4.7111');
  form.set('longitude', '-74.072');
  form.set('accuracyMeters', '18');
  form.set('clientCapturedAt', NOW.toISOString());
  form.set('photoConsent', includePhoto ? 'true' : 'false');
  if (includePhoto) {
    form.set('selfie', new Blob([Buffer.from('jpeg-test')], { type: 'image/jpeg' }), 'selfie.jpg');
  }
  return form;
}

test('registra llegada únicamente después de resolver sesión, propiedad, instalación y evidencia', async () => {
  let observedAssignmentInput;
  let observedEvidenceInput;
  let observedArrivalInput;

  await withServer({
    loadAssignmentForArrivalFn: async (_prisma, input) => {
      observedAssignmentInput = input;
      return {
        id: 'assignment-1',
        attendanceEnabled: true,
        arrivalReported: false,
        canRegisterArrival: true,
        arrivalWindowOpensAt: '2026-07-22T12:00:00.000Z',
        photoRequired: true
      };
    },
    storeArrivalEvidenceFn: async (input) => {
      observedEvidenceInput = input;
      return { storageKey: 'attendance/evidence.jpg', mimeType: 'image/jpeg', created: true };
    },
    registerArrivalFn: async (_prisma, input) => {
      observedArrivalInput = input;
      return {
        recorded: true,
        replayed: false,
        validation: {
          validationStatus: 'AUTO_VALIDATED',
          attendanceStatus: 'ON_TIME',
          reportedPunctuality: 'ON_TIME'
        }
      };
    }
  }, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-1/llegada`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader(),
        'X-Requested-With': 'worker-portal'
      },
      body: arrivalForm()
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.validationStatus, 'AUTO_VALIDATED');
  });

  assert.equal(observedAssignmentInput.workerId, 'worker-1');
  assert.equal(observedAssignmentInput.assignmentId, 'assignment-1');
  assert.equal(observedEvidenceInput.workerId, 'worker-1');
  assert.equal(observedEvidenceInput.file.mimetype, 'image/jpeg');
  assert.equal(observedArrivalInput.expectedWorkerId, 'worker-1');
  assert.equal(observedArrivalInput.assignmentId, 'assignment-1');
  assert.equal(observedArrivalInput.hasFreshPhoto, true);
  assert.match(observedArrivalInput.installationIdHash, /^[a-f0-9]{64}$/);
});

test('no permite consultar ni marcar una asignación que no pertenece a la sesión', async () => {
  let registerCalls = 0;
  await withServer({
    loadAssignmentForArrivalFn: async () => null,
    storeArrivalEvidenceFn: async () => {
      throw new Error('must_not_store');
    },
    registerArrivalFn: async () => {
      registerCalls += 1;
    }
  }, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/other-assignment/llegada`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader(),
        'X-Requested-With': 'worker-portal'
      },
      body: arrivalForm({ includePhoto: false })
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: 'assignment_not_available' });
  });
  assert.equal(registerCalls, 0);
});

test('exige selfie y autorización cuando la política de la operación la solicita', async () => {
  await withServer({
    loadAssignmentForArrivalFn: async () => ({
      id: 'assignment-1',
      attendanceEnabled: true,
      arrivalReported: false,
      canRegisterArrival: true,
      photoRequired: true
    }),
    registerArrivalFn: async () => {
      throw new Error('must_not_register');
    }
  }, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-1/llegada`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader(),
        'X-Requested-With': 'worker-portal'
      },
      body: arrivalForm({ includePhoto: false })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'selfie_required' });
  });
});

test('redacta el token de activación antes de que morgan escriba la URL', () => {
  const req = {
    method: 'GET',
    originalUrl: `/operaciones/portal/activar?token=${'A'.repeat(43)}&source=test`
  };
  let continued = false;
  redactWorkerPortalActivationUrlForLogging(req, {}, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(req.originalUrl.includes('A'.repeat(43)), false);
  assert.match(req.originalUrl, /token=\[REDACTED\]/);
  assert.match(req.originalUrl, /source=test/);
});
