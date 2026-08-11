import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import { once } from 'node:events';
import { workerPortalRouter } from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const SESSION_TOKEN = 'S'.repeat(43);
const NOW = new Date('2026-07-28T13:00:00.000Z');

function operationAssignment() {
  return {
    id: 'assignment-1',
    workerId: 'worker-1',
    status: 'CONFIRMED',
    serviceRequest: {
      operationPoint: {
        attendanceEnabled: true,
        attendanceLatitude: 4.7111,
        attendanceLongitude: -74.0721,
        geofenceRadiusMeters: 100,
        maxLocationAccuracyMeters: 50
      }
    }
  };
}

function markForm({ latitude, longitude, accuracyMeters = 12 } = {}) {
  const form = new FormData();
  form.set('idempotencyKey', 'strict_mark_123456789');
  form.set('latitude', String(latitude));
  form.set('longitude', String(longitude));
  form.set('accuracyMeters', String(accuracyMeters));
  form.set('clientCapturedAt', NOW.toISOString());
  form.set('captureMode', 'ONLINE_WEB');
  form.set('photoConsent', 'true');
  form.set('selfie', new Blob([Buffer.from('jpeg')], { type: 'image/jpeg' }), 'rostro.jpg');
  return form;
}

function challengeBody({ latitude, longitude, accuracyMeters = 12 } = {}) {
  return JSON.stringify({
    assignmentId: 'assignment-1',
    markType: 'BREAK_START',
    idempotencyKey: 'challenge_location_123456789',
    latitude,
    longitude,
    accuracyMeters,
    clientCapturedAt: NOW.toISOString()
  });
}

async function withServer({ auditEvent = null } = {}, callback) {
  let attendanceQueries = 0;
  let challengeCalls = 0;
  const prisma = {
    dispatchAssignment: {
      async findFirst() {
        attendanceQueries += 1;
        return operationAssignment();
      }
    },
    devAuditEvent: {
      async findFirst() {
        return auditEvent;
      }
    }
  };
  const app = express();
  app.use('/operaciones/portal', workerPortalRouter(prisma, {
    repository: {},
    nowFn: () => NOW,
    resolveSessionFn: async () => ({
      workerId: 'worker-1',
      deviceId: 'device-1',
      sessionId: 'session-1',
      expiresAt: new Date('2026-08-04T13:00:00.000Z')
    }),
    loadAssignmentsFn: async () => [],
    getEnrollmentFn: async () => ({ enrolled: true, descriptor: [1], evidenceVersion: 2 }),
    assertAttemptAllowedFn: async () => ({ allowed: true }),
    issueChallengeFn: () => {
      challengeCalls += 1;
      return {
        token: 'challenge-token-test',
        action: 'TURN_SIDE',
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString()
      };
    }
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ ok: false, error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback(origin, () => attendanceQueries, () => challengeCalls);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function requestHeaders() {
  return {
    Cookie: `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${SESSION_TOKEN}`,
    'X-Requested-With': 'worker-portal'
  };
}

function jsonRequestHeaders() {
  return { ...requestHeaders(), 'Content-Type': 'application/json' };
}

test('rechaza una llegada ubicada fuera del radio de la operación', async () => {
  await withServer({}, async (origin, queryCount) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-1/llegada`, {
      method: 'POST',
      headers: requestHeaders(),
      body: markForm({ latitude: 6.2442, longitude: -75.5812 })
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'outside_operation_range');
    assert.equal(queryCount(), 1);
  });
});

test('rechaza una llegada dentro de la geocerca si no existe evaluación facial verificada', async () => {
  await withServer({}, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-1/llegada`, {
      method: 'POST',
      headers: requestHeaders(),
      body: markForm({ latitude: 4.71115, longitude: -74.07205 })
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'biometric_verification_required');
  });
});

test('no emite desafío biométrico cuando la ubicación está fuera del radio', async () => {
  await withServer({}, async (origin, _queryCount, challengeCount) => {
    const response = await fetch(`${origin}/operaciones/portal/biometria/desafio`, {
      method: 'POST',
      headers: jsonRequestHeaders(),
      body: challengeBody({ latitude: 6.2442, longitude: -75.5812 })
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'outside_operation_range');
    assert.equal(challengeCount(), 0);
  });
});

test('no emite desafío biométrico con precisión de ubicación insuficiente', async () => {
  await withServer({}, async (origin, _queryCount, challengeCount) => {
    const response = await fetch(`${origin}/operaciones/portal/biometria/desafio`, {
      method: 'POST',
      headers: jsonRequestHeaders(),
      body: challengeBody({ latitude: 4.71115, longitude: -74.07205, accuracyMeters: 80 })
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'location_accuracy_insufficient');
    assert.equal(challengeCount(), 0);
  });
});

test('emite desafío biométrico únicamente después de validar una ubicación dentro de la geocerca', async () => {
  await withServer({}, async (origin, _queryCount, challengeCount) => {
    const response = await fetch(`${origin}/operaciones/portal/biometria/desafio`, {
      method: 'POST',
      headers: jsonRequestHeaders(),
      body: challengeBody({ latitude: 4.71115, longitude: -74.07205, accuracyMeters: 12 })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.challenge?.token, 'challenge-token-test');
    assert.equal(challengeCount(), 1);
  });
});

test('el cliente espera ubicación y conserva la causa biométrica accionable', () => {
  const flow = fs.readFileSync(new URL('../src/public/worker-portal-biometric-flow.js', import.meta.url), 'utf8');
  assert.match(flow, /if \(!state\.locationEvidence\) throw new Error\('attendance_location_pending'\)/);
  assert.match(flow, /latitude:\s*state\.locationEvidence\.latitude/);
  assert.match(flow, /longitude:\s*state\.locationEvidence\.longitude/);
  assert.match(flow, /accuracyMeters:\s*state\.locationEvidence\.accuracyMeters/);
  assert.match(flow, /error\?\.payload\?\.riskFlags/);
  assert.match(flow, /BIOMETRIC_FACE_MISMATCH/);
  assert.match(flow, /El rostro capturado no coincidió suficientemente con el registro/);
});
