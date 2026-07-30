import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
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

async function withServer({ auditEvent = null } = {}, callback) {
  let attendanceQueries = 0;
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
    loadAssignmentsFn: async () => []
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ ok: false, error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback(origin, () => attendanceQueries);
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

async function assertBiometricRequired(path, options = {}) {
  await withServer(options, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal/asignaciones/assignment-1/${path}`, {
      method: 'POST',
      headers: requestHeaders(),
      body: markForm({ latitude: 4.71115, longitude: -74.07205 })
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'biometric_verification_required');
  });
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

test('rechaza una llegada dentro de la geocerca sin evaluación facial verificada', async () => {
  await assertBiometricRequired('llegada');
});

test('rechaza el inicio de almuerzo sin evaluación facial verificada', async () => {
  await assertBiometricRequired('inicio-almuerzo');
});

test('rechaza el fin de almuerzo sin evaluación facial verificada', async () => {
  await assertBiometricRequired('fin-almuerzo');
});

test('una evaluación de llegada no autoriza el inicio de almuerzo', async () => {
  await assertBiometricRequired('inicio-almuerzo', {
    auditEvent: {
      metadata: {
        decision: 'VERIFIED',
        verified: true,
        workerId: 'worker-1',
        assignmentId: 'assignment-1',
        markType: 'ARRIVAL'
      }
    }
  });
});