import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import { once } from 'node:events';
import { workerPortalRouter } from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const NOW = new Date('2026-07-28T18:00:00.000Z');
const SESSION_TOKEN = 'S'.repeat(43);
const DESCRIPTOR = Array.from({ length: 64 }, (_, index) => index / 1000);

async function withServer(options, callback) {
  const app = express();
  app.use('/operaciones/portal', workerPortalRouter({}, {
    repository: {},
    nowFn: () => NOW,
    nonceBytesFn: (size) => Buffer.alloc(size, 4),
    resolveSessionFn: async () => ({
      workerId: 'worker-1',
      deviceId: 'device-1',
      sessionId: 'session-1',
      expiresAt: new Date('2026-08-04T18:00:00.000Z')
    }),
    loadAssignmentsFn: async () => [],
    registerArrivalFn: async () => ({ recorded: false, validation: { riskFlags: [] } }),
    getEnrollmentFn: async () => ({ enrolled: true, descriptor: DESCRIPTOR }),
    loadBiometricAssignmentFn: async (workerId, assignmentId) => ({
      id: assignmentId,
      workerId,
      serviceRequest: { operationPoint: { attendanceEnabled: true } }
    }),
    ...options
  }));
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

function portalHeaders() {
  return {
    Cookie: `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${SESSION_TOKEN}`,
    'Content-Type': 'application/json',
    'X-Requested-With': 'worker-portal'
  };
}

test('el desafío facial usa la cookie del portal y no una sesión administrativa', async () => {
  let observedInput = null;
  await withServer({
    issueChallengeFn: (input) => {
      observedInput = input;
      return { token: 'challenge-token', action: 'TURN_SIDE', expiresAt: NOW.toISOString() };
    }
  }, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/biometria/desafio`, {
      method: 'POST',
      headers: portalHeaders(),
      body: JSON.stringify({
        assignmentId: 'assignment-1',
        markType: 'ARRIVAL',
        idempotencyKey: 'arrival_session_route_123'
      })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.challenge.token, 'challenge-token');
  });
  assert.deepEqual(observedInput, {
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey: 'arrival_session_route_123',
    markType: 'ARRIVAL'
  });
});

test('la verificación facial se registra desde la misma ruta protegida del portal', async () => {
  let observedInput = null;
  await withServer({
    assessBiometricFn: async (input) => {
      observedInput = input;
      return { verified: true, decision: 'VERIFIED' };
    }
  }, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/biometria/verificar`, {
      method: 'POST',
      headers: portalHeaders(),
      body: JSON.stringify({
        assignmentId: 'assignment-1',
        markType: 'DEPARTURE',
        idempotencyKey: 'departure_session_route_123',
        challengeToken: 'challenge-token',
        challengeAction: 'MOVE_CLOSER',
        challengeCompleted: true,
        descriptor: DESCRIPTOR,
        realScore: 0.9,
        liveScore: 0.9,
        modelVersion: 'human-3.3.6-faceres'
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      decision: 'VERIFIED',
      verified: true,
      requiresReview: false
    });
  });
  assert.equal(observedInput.workerId, 'worker-1');
  assert.equal(observedInput.assignmentId, 'assignment-1');
  assert.equal(observedInput.markType, 'DEPARTURE');
  assert.equal(observedInput.challengeCompleted, true);
});

test('las llamadas heredadas del navegador se redirigen al alcance de la cookie del portal', () => {
  const hardening = fs.readFileSync('src/public/worker-portal-hardening.js', 'utf8');
  const route = fs.readFileSync('src/routes/workerPortal.js', 'utf8');
  assert.match(hardening, /\/admin\/operaciones\/portal-activaciones\/biometria\/desafio/);
  assert.match(hardening, /\/operaciones\/portal\/biometria\/desafio/);
  assert.match(hardening, /rewriteBiometricInput/);
  assert.match(route, /router\.post\('\/biometria\/desafio'/);
  assert.match(route, /router\.post\('\/biometria\/verificar'/);
  assert.match(route, /resolvePortalSession\(req, now\)/);
});
