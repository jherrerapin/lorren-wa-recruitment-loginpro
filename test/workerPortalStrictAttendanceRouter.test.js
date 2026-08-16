import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import { once } from 'node:events';
import { workerPortalRouter } from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import {
  buildNativeAttendanceLocationCanonicalProof,
  issueCrewPresenceCredential,
  verifyNativeAttendanceLocationProof
} from '../src/modules/dispatch-attendance/application/crewPresenceCredential.js';

const SESSION_TOKEN = 'S'.repeat(43);
const NOW = new Date('2026-07-28T13:00:00.000Z');
const NATIVE_SECRET = 'TEST-native-location-secret-000000000000000000000000000000000000';
const NATIVE_ASSIGNMENT_ID = 'assignment-1';
const NATIVE_WORKER_ID = 'worker-1';
const NATIVE_DEVICE_ID = 'device-1';
const NATIVE_IDEMPOTENCY_KEY = 'challenge_location_123456789';

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

function challengePayload({ latitude, longitude, accuracyMeters = 12, nativeLocationProof } = {}) {
  return {
    assignmentId: 'assignment-1',
    markType: 'BREAK_START',
    idempotencyKey: NATIVE_IDEMPOTENCY_KEY,
    latitude,
    longitude,
    accuracyMeters,
    clientCapturedAt: NOW.toISOString(),
    ...(nativeLocationProof ? { nativeLocationProof } : {})
  };
}

function challengeBody(options = {}) {
  return JSON.stringify(challengePayload(options));
}

async function withServer({ auditEvent = null, routerOptions = {} } = {}, callback) {
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
      workerId: NATIVE_WORKER_ID,
      deviceId: NATIVE_DEVICE_ID,
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
    },
    ...routerOptions
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

function nativeJsonRequestHeaders() {
  return { ...jsonRequestHeaders(), 'User-Agent': 'TestBrowser LorrenNative/1' };
}

function createNativeLocationProof({
  isMock = false,
  latitude = '4.7111500',
  longitude = '-74.0720500',
  accuracyMeters = '12.00',
  markType = 'BREAK_START',
  idempotencyKey = NATIVE_IDEMPOTENCY_KEY,
  assignmentId = NATIVE_ASSIGNMENT_ID,
  capturedAt = NOW.getTime()
} = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const issued = issueCrewPresenceCredential({
    workerId: NATIVE_WORKER_ID,
    deviceId: NATIVE_DEVICE_ID,
    publicKey: publicKeyBase64,
    now: new Date(capturedAt - 60_000)
  }, { secret: NATIVE_SECRET });
  const unsigned = {
    version: 1,
    assignmentId,
    markType,
    idempotencyKey,
    latitude,
    longitude,
    accuracyMeters,
    capturedAt,
    isMock,
    publicKey: publicKeyBase64,
    credential: issued.credential
  };
  const canonical = buildNativeAttendanceLocationCanonicalProof(unsigned);
  return {
    ...unsigned,
    signature: sign('sha256', Buffer.from(canonical, 'utf8'), privateKey).toString('base64')
  };
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

test('el verificador nativo liga ubicación a trabajador, dispositivo, marca e intento', () => {
  const proof = createNativeLocationProof();
  const verified = verifyNativeAttendanceLocationProof({
    workerId: NATIVE_WORKER_ID,
    deviceId: NATIVE_DEVICE_ID,
    assignmentId: NATIVE_ASSIGNMENT_ID,
    markType: 'BREAK_START',
    idempotencyKey: NATIVE_IDEMPOTENCY_KEY,
    proof,
    now: NOW
  }, { secret: NATIVE_SECRET });

  assert.equal(verified.latitude, 4.71115);
  assert.equal(verified.longitude, -74.07205);
  assert.equal(verified.accuracyMeters, 12);
  assert.equal(verified.credential.workerId, NATIVE_WORKER_ID);
  assert.equal(verified.credential.deviceId, NATIVE_DEVICE_ID);
});

test('una ubicación firmada por Android como simulada nunca alimenta una marcación individual', () => {
  const proof = createNativeLocationProof({ isMock: true });
  assert.throws(() => verifyNativeAttendanceLocationProof({
    workerId: NATIVE_WORKER_ID,
    deviceId: NATIVE_DEVICE_ID,
    assignmentId: NATIVE_ASSIGNMENT_ID,
    markType: 'BREAK_START',
    idempotencyKey: NATIVE_IDEMPOTENCY_KEY,
    proof,
    now: NOW
  }, { secret: NATIVE_SECRET }), /attendance_mock_location_detected/);
});

test('alterar coordenadas, dispositivo o contexto invalida la prueba nativa', () => {
  const proof = createNativeLocationProof();
  assert.throws(() => verifyNativeAttendanceLocationProof({
    workerId: NATIVE_WORKER_ID,
    deviceId: NATIVE_DEVICE_ID,
    assignmentId: NATIVE_ASSIGNMENT_ID,
    markType: 'BREAK_START',
    idempotencyKey: NATIVE_IDEMPOTENCY_KEY,
    proof: { ...proof, latitude: '4.7999999' },
    now: NOW
  }, { secret: NATIVE_SECRET }), /attendance_native_location_identity_invalid/);

  assert.throws(() => verifyNativeAttendanceLocationProof({
    workerId: NATIVE_WORKER_ID,
    deviceId: 'device-other',
    assignmentId: NATIVE_ASSIGNMENT_ID,
    markType: 'BREAK_START',
    idempotencyKey: NATIVE_IDEMPOTENCY_KEY,
    proof,
    now: NOW
  }, { secret: NATIVE_SECRET }), /attendance_native_location_identity_invalid/);

  assert.throws(() => verifyNativeAttendanceLocationProof({
    workerId: NATIVE_WORKER_ID,
    deviceId: NATIVE_DEVICE_ID,
    assignmentId: NATIVE_ASSIGNMENT_ID,
    markType: 'DEPARTURE',
    idempotencyKey: NATIVE_IDEMPOTENCY_KEY,
    proof,
    now: NOW
  }, { secret: NATIVE_SECRET }), /attendance_native_location_invalid/);
});

test('el APK no puede iniciar desafío sin prueba nativa aunque mande coordenadas web válidas', async () => {
  await withServer({}, async (origin, _queryCount, challengeCount) => {
    const response = await fetch(`${origin}/operaciones/portal/biometria/desafio`, {
      method: 'POST',
      headers: nativeJsonRequestHeaders(),
      body: challengeBody({ latitude: 4.71115, longitude: -74.07205 })
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error, 'attendance_native_location_required');
    assert.equal(challengeCount(), 0);
  });
});

test('el APK bloquea fake GPS antes de emitir desafío biométrico', async () => {
  await withServer({
    routerOptions: {
      verifyNativeAttendanceLocationProofFn: () => {
        throw new Error('attendance_mock_location_detected');
      }
    }
  }, async (origin, _queryCount, challengeCount) => {
    const response = await fetch(`${origin}/operaciones/portal/biometria/desafio`, {
      method: 'POST',
      headers: nativeJsonRequestHeaders(),
      body: challengeBody({
        latitude: 4.71115,
        longitude: -74.07205,
        nativeLocationProof: { version: 1 }
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.error, 'attendance_mock_location_detected');
    assert.equal(challengeCount(), 0);
  });
});

test('en el APK la geocerca usa coordenadas verificadas y no las coordenadas web del body', async () => {
  await withServer({
    routerOptions: {
      verifyNativeAttendanceLocationProofFn: () => ({
        latitude: 4.71115,
        longitude: -74.07205,
        accuracyMeters: 12,
        clientCapturedAt: NOW.toISOString()
      })
    }
  }, async (origin, _queryCount, challengeCount) => {
    const response = await fetch(`${origin}/operaciones/portal/biometria/desafio`, {
      method: 'POST',
      headers: nativeJsonRequestHeaders(),
      body: challengeBody({
        latitude: 6.2442,
        longitude: -75.5812,
        nativeLocationProof: { version: 1 }
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(challengeCount(), 1);
  });
});

test('el cliente nativo obtiene proof firmado antes del desafío y conserva fallback PWA separado', () => {
  const flow = fs.readFileSync(new URL('../src/public/worker-portal-biometric-flow.js', import.meta.url), 'utf8');
  assert.match(flow, /nativeAttendanceLocationEnabled/);
  assert.match(flow, /requestAttendanceLocation/);
  assert.match(flow, /attendance_location_ready/);
  assert.match(flow, /attendance_location_error/);
  assert.match(flow, /state\.nativeLocationProof/);
  assert.match(flow, /nativeLocationProof:\s*state\.nativeLocationProof/);
  assert.match(flow, /form\.set\('nativeLocationProof', JSON\.stringify\(state\.nativeLocationProof\)\)/);
  assert.match(flow, /if \(!state\.locationEvidence \|\| !state\.idempotencyKey\) throw new Error\('attendance_location_pending'\)/);
  assert.match(flow, /latitude:\s*state\.locationEvidence\.latitude/);
  assert.match(flow, /longitude:\s*state\.locationEvidence\.longitude/);
  assert.match(flow, /accuracyMeters:\s*state\.locationEvidence\.accuracyMeters/);
  assert.match(flow, /error\?\.payload\?\.riskFlags/);
  assert.match(flow, /BIOMETRIC_FACE_MISMATCH/);
  assert.match(flow, /Android detectó una ubicación simulada/);

  const requestLocationBlock = flow.match(
    /function requestLocation\(localRunToken\) \{([\s\S]*?)\n  \}\n\n  function handleNativeAttendanceLocation/
  );
  assert.ok(requestLocationBlock, 'falta autoridad requestLocation');
  assert.match(
    requestLocationBlock[1],
    /if \(nativeAttendanceLocationEnabled\) \{[\s\S]*?requestNativeLocation\(localRunToken\);[\s\S]*?return;/
  );
  assert.match(requestLocationBlock[1], /navigator\.geolocation\.getCurrentPosition/);
});
