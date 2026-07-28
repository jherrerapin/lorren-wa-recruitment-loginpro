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
const NOW = new Date('2026-07-25T17:00:00.000Z');

function cookieHeader() {
  return `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${SESSION_TOKEN}; ${WORKER_PORTAL_INSTALLATION_COOKIE_NAME}=${INSTALLATION_ID}`;
}

function breakForm(markType) {
  const form = new FormData();
  form.set('idempotencyKey', `${markType.toLowerCase()}_route_123456789`);
  form.set('latitude', '4.7111');
  form.set('longitude', '-74.072');
  form.set('accuracyMeters', '12');
  form.set('clientCapturedAt', NOW.toISOString());
  form.set('captureMode', 'ONLINE_WEB');
  form.set('persistentStorageAvailable', 'true');
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
      expiresAt: new Date('2026-08-01T22:00:00.000Z')
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

test('registra inicio de almuerzo sin exigir fotografía', async () => {
  let observedInput;
  await withServer({
    loadAssignmentForBreakFn: async () => ({
      id: 'assignment-1',
      attendanceEnabled: true,
      arrivalReported: true,
      departureReported: false,
      breakStarted: false,
      breakEnded: false,
      photoRequired: true
    }),
    registerBreakFn: async (_prisma, input) => {
      observedInput = input;
      return {
        recorded: true,
        replayed: false,
        attendanceSession: { attendanceStatus: 'ON_TIME' },
        validation: { validationStatus: 'AUTO_VALIDATED', riskFlags: [] }
      };
    }
  }, async (origin) => {
    const response = await fetch(
      `${origin}/operaciones/portal/asignaciones/assignment-1/inicio-almuerzo`,
      {
        method: 'POST',
        headers: { Cookie: cookieHeader(), 'X-Requested-With': 'worker-portal' },
        body: breakForm('BREAK_START')
      }
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.markType, 'BREAK_START');
    assert.match(payload.message, /dejará de contabilizarse/i);
  });
  assert.equal(observedInput.markType, 'BREAK_START');
  assert.equal(observedInput.expectedWorkerId, 'worker-1');
  assert.equal(observedInput.evidenceStorageKey, null);
});

test('registra fin de almuerzo y reactiva el conteo', async () => {
  await withServer({
    loadAssignmentForBreakFn: async () => ({
      id: 'assignment-1',
      attendanceEnabled: true,
      arrivalReported: true,
      departureReported: false,
      breakStarted: true,
      breakEnded: false,
      photoRequired: false
    }),
    registerBreakFn: async () => ({
      recorded: true,
      replayed: false,
      attendanceSession: { attendanceStatus: 'ON_TIME' },
      validation: { validationStatus: 'AUTO_VALIDATED', riskFlags: [] }
    })
  }, async (origin) => {
    const response = await fetch(
      `${origin}/operaciones/portal/asignaciones/assignment-1/fin-almuerzo`,
      {
        method: 'POST',
        headers: { Cookie: cookieHeader(), 'X-Requested-With': 'worker-portal' },
        body: breakForm('BREAK_END')
      }
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.markType, 'BREAK_END');
    assert.match(payload.message, /vuelve a contabilizarse/i);
  });
});

test('bloquea fin de almuerzo sin inicio previo', async () => {
  let registerCalls = 0;
  await withServer({
    loadAssignmentForBreakFn: async () => ({
      id: 'assignment-1',
      attendanceEnabled: true,
      arrivalReported: true,
      departureReported: false,
      breakStarted: false,
      breakEnded: false,
      photoRequired: false
    }),
    registerBreakFn: async () => { registerCalls += 1; }
  }, async (origin) => {
    const response = await fetch(
      `${origin}/operaciones/portal/asignaciones/assignment-1/fin-almuerzo`,
      {
        method: 'POST',
        headers: { Cookie: cookieHeader(), 'X-Requested-With': 'worker-portal' },
        body: breakForm('BREAK_END')
      }
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { ok: false, error: 'break_start_required' });
  });
  assert.equal(registerCalls, 0);
});
