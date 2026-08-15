import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  buildCrewNativeLocationCanonicalProof,
  buildCrewPresenceCanonicalProof,
  issueCrewPresenceCredential,
  readCrewPresenceCredential,
  verifyCrewPresenceBundle
} from '../src/modules/dispatch-attendance/application/crewPresenceCredential.js';
import { registerCrewArrivalForLeader } from '../src/modules/dispatch-attendance/application/registerCrewArrival.js';

const SECRET = 'TEST-crew-presence-secret-00000000000000000000000000000000';
const SERVICE_ID = 'TEST-SERVICE-CREW-01';
const LEADER_WORKER_ID = 'TEST-WORKER-01';
const LEADER_ASSIGNMENT_ID = 'TEST-ASSIGNMENT-01';
const LEADER_DEVICE_ID = 'TEST-DEVICE-01';
const ATTEMPT_ID = 'TEST-CREW-ATTEMPT-0001';
const CHALLENGE = 'TEST-CHALLENGE-000000000000000000000000000001';
const CAPTURED_AT = new Date('2026-08-14T18:00:00-05:00');
const SERVER_NOW = new Date('2026-08-14T20:00:00-05:00');

function workerId(index) {
  return `TEST-WORKER-${String(index).padStart(2, '0')}`;
}

function assignmentId(index) {
  return `TEST-ASSIGNMENT-${String(index).padStart(2, '0')}`;
}

function deviceId(index) {
  return `TEST-DEVICE-${String(index).padStart(2, '0')}`;
}

function member(index, arrived = false) {
  return {
    id: assignmentId(index),
    workerId: workerId(index),
    attendanceSession: arrived
      ? { arrivalReportedAt: new Date(CAPTURED_AT.getTime() - 60_000) }
      : null
  };
}

function generatePresenceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  };
}

function createProof(index, options = {}) {
  const keys = options.keys || generatePresenceKey();
  const respondedAt = options.respondedAt ?? CAPTURED_AT.getTime() + index * 100;
  const issued = issueCrewPresenceCredential({
    workerId: options.workerId || workerId(index),
    deviceId: options.deviceId || deviceId(index),
    publicKey: keys.publicKey,
    now: new Date(CAPTURED_AT.getTime() - 60_000)
  }, { secret: SECRET });
  const canonical = buildCrewPresenceCanonicalProof({
    attemptId: options.attemptId || ATTEMPT_ID,
    serviceRequestId: options.serviceRequestId || SERVICE_ID,
    challenge: options.challenge || CHALLENGE,
    respondedAt
  });
  const signature = sign('sha256', Buffer.from(canonical, 'utf8'), keys.privateKey).toString('base64');
  return {
    version: 1,
    serviceRequestId: options.serviceRequestId || SERVICE_ID,
    attemptId: options.attemptId || ATTEMPT_ID,
    challenge: options.challenge || CHALLENGE,
    respondedAt,
    publicKey: keys.publicKey,
    signature: options.signature || signature,
    credential: issued.credential,
    credentialState: 'PROVISIONED'
  };
}

function createLeaderLocationProof(options = {}) {
  const keys = options.keys || generatePresenceKey();
  const capturedAt = options.capturedAt ?? CAPTURED_AT.getTime();
  const attemptId = options.attemptId || ATTEMPT_ID;
  const serviceRequestId = options.serviceRequestId || SERVICE_ID;
  const latitude = options.latitude || '4.6000000';
  const longitude = options.longitude || '-74.0800000';
  const accuracyMeters = options.accuracyMeters || '12.00';
  const isMock = options.isMock === true;
  const issued = issueCrewPresenceCredential({
    workerId: options.workerId || LEADER_WORKER_ID,
    deviceId: options.deviceId || LEADER_DEVICE_ID,
    publicKey: keys.publicKey,
    now: new Date(CAPTURED_AT.getTime() - 60_000)
  }, { secret: SECRET });
  const canonical = buildCrewNativeLocationCanonicalProof({
    attemptId,
    serviceRequestId,
    latitude,
    longitude,
    accuracyMeters,
    capturedAt,
    isMock
  });
  const signature = sign('sha256', Buffer.from(canonical, 'utf8'), keys.privateKey).toString('base64');
  return {
    version: 1,
    attemptId,
    serviceRequestId,
    latitude,
    longitude,
    accuracyMeters,
    capturedAt,
    isMock,
    publicKey: keys.publicKey,
    signature: options.signature || signature,
    credential: issued.credential
  };
}

function activeDevice(index) {
  return {
    id: deviceId(index),
    workerId: workerId(index),
    installationIdHash: `TEST-INSTALL-HASH-${String(index).padStart(2, '0')}`,
    authorizedFrom: new Date(CAPTURED_AT.getTime() - 24 * 60 * 60 * 1000),
    authorizedUntil: null
  };
}

function leaderContext() {
  return [{
    assignmentId: LEADER_ASSIGNMENT_ID,
    serviceRequestId: SERVICE_ID,
    operationPointId: 'TEST-OPERATION-01',
    mode: 'CREW',
    isCrewLeader: true,
    crewAvailable: true,
    proximityRequired: true
  }];
}

function createVerifyPrisma({ members, devices }) {
  return {
    dispatchAssignment: {
      findMany: async () => members
    },
    dispatchWorkerDevice: {
      findMany: async ({ where }) => devices.filter((device) => where.id.in.includes(device.id))
    }
  };
}

test('credencial de presencia liga worker, dispositivo y clave pública sin PII', () => {
  const keys = generatePresenceKey();
  const issued = issueCrewPresenceCredential({
    workerId: LEADER_WORKER_ID,
    deviceId: LEADER_DEVICE_ID,
    publicKey: keys.publicKey,
    now: CAPTURED_AT
  }, { secret: SECRET, ttlMs: 60 * 60 * 1000 });
  const parsed = readCrewPresenceCredential({
    credential: issued.credential,
    at: new Date(CAPTURED_AT.getTime() + 30 * 60 * 1000)
  }, { secret: SECRET });

  assert.equal(parsed.workerId, LEADER_WORKER_ID);
  assert.equal(parsed.deviceId, LEADER_DEVICE_ID);
  assert.equal(typeof parsed.keyHash, 'string');
  assert.ok(parsed.keyHash.length > 20);
  assert.doesNotMatch(issued.credential, /telefono|documento|nombre|@/i);
});

test('credencial alterada o vencida es rechazada', () => {
  const keys = generatePresenceKey();
  const issued = issueCrewPresenceCredential({
    workerId: 'TEST-WORKER-CREDENTIAL',
    deviceId: 'TEST-DEVICE-CREDENTIAL',
    publicKey: keys.publicKey,
    now: CAPTURED_AT
  }, { secret: SECRET, ttlMs: 15 * 60 * 1000 });

  const [version, payload, signature] = issued.credential.split('.');
  const alteredFirst = signature[0] === 'A' ? 'B' : 'A';
  const tampered = `${version}.${payload}.${alteredFirst}${signature.slice(1)}`;
  assert.throws(
    () => readCrewPresenceCredential({ credential: tampered, at: CAPTURED_AT }, { secret: SECRET }),
    /crew_presence_credential_invalid/
  );
  assert.throws(
    () => readCrewPresenceCredential({
      credential: issued.credential,
      at: new Date(CAPTURED_AT.getTime() + 16 * 60 * 1000)
    }, { secret: SECRET }),
    /crew_presence_credential_expired/
  );
});

test('10 asignados: encargado + 8 proofs válidos producen 9 presentes y uno no detectado', async () => {
  const members = Array.from({ length: 10 }, (_, index) => member(index + 1));
  const proofs = Array.from({ length: 8 }, (_, index) => createProof(index + 2));
  const devices = Array.from({ length: 9 }, (_, index) => activeDevice(index + 1));
  const prisma = createVerifyPrisma({ members, devices });

  const verified = await verifyCrewPresenceBundle(prisma, {
    leaderWorkerId: LEADER_WORKER_ID,
    leaderDeviceId: LEADER_DEVICE_ID,
    assignmentId: LEADER_ASSIGNMENT_ID,
    serviceRequestId: SERVICE_ID,
    idempotencyKey: ATTEMPT_ID,
    clientCapturedAt: CAPTURED_AT,
    proofBundle: {
      version: 1,
      attemptId: ATTEMPT_ID,
      serviceRequestId: SERVICE_ID,
      challenge: CHALLENGE,
      challengeSentAt: CAPTURED_AT.getTime(),
      leaderLocationProof: createLeaderLocationProof(),
      proofs
    },
    now: SERVER_NOW
  }, {
    secret: SECRET,
    loadCrewContextsFn: async () => leaderContext()
  });

  assert.deepEqual(verified.validatedWorkerIds, Array.from({ length: 9 }, (_, index) => workerId(index + 1)));
  assert.equal(verified.totalMembers, 10);
  assert.equal(verified.verifiedProofCount, 8);
  assert.equal(verified.notDetectedCount, 1);
  assert.equal(verified.rejectedProofCount, 0);
  assert.equal(verified.leaderInstallationIdHash, 'TEST-INSTALL-HASH-01');
  assert.deepEqual(verified.leaderLocation, {
    latitude: 4.6,
    longitude: -74.08,
    accuracyMeters: 12,
    clientCapturedAt: CAPTURED_AT.toISOString()
  });
});

test('firma inválida, trabajador ajeno y dispositivo no activo nunca entran al subconjunto validado', async () => {
  const members = Array.from({ length: 10 }, (_, index) => member(index + 1));
  const invalidSignature = createProof(2, { signature: Buffer.from('not-a-valid-ecdsa-signature').toString('base64') });
  const outsider = createProof(11, { workerId: 'TEST-WORKER-OUTSIDE', deviceId: 'TEST-DEVICE-OUTSIDE' });
  const missingDevice = createProof(10);
  const devices = [activeDevice(1), activeDevice(2), activeDevice(11)];
  const prisma = createVerifyPrisma({ members, devices });

  const verified = await verifyCrewPresenceBundle(prisma, {
    leaderWorkerId: LEADER_WORKER_ID,
    leaderDeviceId: LEADER_DEVICE_ID,
    assignmentId: LEADER_ASSIGNMENT_ID,
    serviceRequestId: SERVICE_ID,
    idempotencyKey: ATTEMPT_ID,
    clientCapturedAt: CAPTURED_AT,
    proofBundle: {
      version: 1,
      attemptId: ATTEMPT_ID,
      serviceRequestId: SERVICE_ID,
      challenge: CHALLENGE,
      challengeSentAt: CAPTURED_AT.getTime(),
      leaderLocationProof: createLeaderLocationProof(),
      proofs: [invalidSignature, outsider, missingDevice]
    },
    now: SERVER_NOW
  }, {
    secret: SECRET,
    loadCrewContextsFn: async () => leaderContext()
  });

  assert.deepEqual(verified.validatedWorkerIds, [LEADER_WORKER_ID]);
  assert.equal(verified.verifiedProofCount, 0);
  assert.equal(verified.notDetectedCount, 9);
  assert.equal(verified.rejectedProofCount, 3);
});

test('ubicación nativa firmada marcada como simulada bloquea todo el intento', async () => {
  const prisma = createVerifyPrisma({
    members: [member(1)],
    devices: [activeDevice(1)]
  });

  await assert.rejects(
    verifyCrewPresenceBundle(prisma, {
      leaderWorkerId: LEADER_WORKER_ID,
      leaderDeviceId: LEADER_DEVICE_ID,
      assignmentId: LEADER_ASSIGNMENT_ID,
      serviceRequestId: SERVICE_ID,
      idempotencyKey: ATTEMPT_ID,
      clientCapturedAt: CAPTURED_AT,
      proofBundle: {
        version: 1,
        attemptId: ATTEMPT_ID,
        serviceRequestId: SERVICE_ID,
        challenge: CHALLENGE,
        challengeSentAt: CAPTURED_AT.getTime(),
        leaderLocationProof: createLeaderLocationProof({ isMock: true }),
        proofs: []
      },
      now: SERVER_NOW
    }, {
      secret: SECRET,
      loadCrewContextsFn: async () => leaderContext()
    }),
    /crew_presence_mock_location_detected/
  );
});

test('firma alterada de ubicación nativa no puede alimentar la geocerca', async () => {
  const prisma = createVerifyPrisma({
    members: [member(1)],
    devices: [activeDevice(1)]
  });
  const invalidLocation = createLeaderLocationProof({
    signature: Buffer.from('invalid-native-location-signature').toString('base64')
  });

  await assert.rejects(
    verifyCrewPresenceBundle(prisma, {
      leaderWorkerId: LEADER_WORKER_ID,
      leaderDeviceId: LEADER_DEVICE_ID,
      assignmentId: LEADER_ASSIGNMENT_ID,
      serviceRequestId: SERVICE_ID,
      idempotencyKey: ATTEMPT_ID,
      clientCapturedAt: CAPTURED_AT,
      proofBundle: {
        version: 1,
        attemptId: ATTEMPT_ID,
        serviceRequestId: SERVICE_ID,
        challenge: CHALLENGE,
        challengeSentAt: CAPTURED_AT.getTime(),
        leaderLocationProof: invalidLocation,
        proofs: []
      },
      now: SERVER_NOW
    }, {
      secret: SECRET,
      loadCrewContextsFn: async () => leaderContext()
    }),
    /crew_presence_native_location_identity_invalid/
  );
});

test('reintento de proof no vuelve a contar como ausentes a quienes ya tenían llegada', async () => {
  const members = Array.from({ length: 10 }, (_, index) => member(index + 1, index >= 1 && index <= 8));
  const retryAttemptId = 'TEST-CREW-ATTEMPT-0002';
  const retryChallenge = 'TEST-CHALLENGE-000000000000000000000000000002';
  const retryCapturedAt = new Date(CAPTURED_AT.getTime() + 5 * 60 * 1000);
  const proof = createProof(10, {
    attemptId: retryAttemptId,
    challenge: retryChallenge,
    respondedAt: retryCapturedAt.getTime()
  });
  const devices = [activeDevice(1), activeDevice(10)];
  const prisma = createVerifyPrisma({ members, devices });

  const verified = await verifyCrewPresenceBundle(prisma, {
    leaderWorkerId: LEADER_WORKER_ID,
    leaderDeviceId: LEADER_DEVICE_ID,
    assignmentId: LEADER_ASSIGNMENT_ID,
    serviceRequestId: SERVICE_ID,
    idempotencyKey: retryAttemptId,
    clientCapturedAt: retryCapturedAt,
    proofBundle: {
      version: 1,
      attemptId: retryAttemptId,
      serviceRequestId: SERVICE_ID,
      challenge: retryChallenge,
      challengeSentAt: retryCapturedAt.getTime(),
      leaderLocationProof: createLeaderLocationProof({
        attemptId: retryAttemptId,
        capturedAt: retryCapturedAt.getTime()
      }),
      proofs: [proof]
    },
    now: SERVER_NOW
  }, {
    secret: SECRET,
    loadCrewContextsFn: async () => leaderContext()
  });

  assert.deepEqual(verified.validatedWorkerIds, [LEADER_WORKER_ID, workerId(10)]);
  assert.equal(verified.notDetectedCount, 0);
});

function recordedResult(id, { replayed = false } = {}) {
  return {
    recorded: true,
    replayed,
    attendanceSession: { id: `TEST-SESSION-${id}`, validationStatus: 'MANUAL_VALIDATED' },
    validation: {
      validationStatus: 'MANUAL_VALIDATED',
      reportedPunctuality: 'ON_TIME',
      riskFlags: []
    }
  };
}

function duplicateResult(id) {
  return {
    recorded: false,
    replayed: false,
    attendanceSession: { id: `TEST-SESSION-${id}`, validationStatus: 'MANUAL_VALIDATED' },
    validation: {
      validationStatus: 'MANUAL_VALIDATED',
      riskFlags: ['DUPLICATE_ARRIVAL']
    }
  };
}

test('fan-out verificable llama al escritor canónico solo para los 9 detectados', async () => {
  const members = Array.from({ length: 10 }, (_, index) => member(index + 1));
  const calls = [];
  const prisma = {
    dispatchAssignment: { findMany: async () => members }
  };

  const result = await registerCrewArrivalForLeader(prisma, {
    leaderWorkerId: LEADER_WORKER_ID,
    assignmentId: LEADER_ASSIGNMENT_ID,
    idempotencyKey: ATTEMPT_ID,
    now: SERVER_NOW,
    captureMode: 'OFFLINE_WEB',
    clientCapturedAt: CAPTURED_AT,
    latitude: 4.60,
    longitude: -74.08,
    accuracyMeters: 12,
    installationIdHash: 'TEST-INSTALL-HASH-01',
    presenceValidated: true,
    validatedWorkerIds: Array.from({ length: 9 }, (_, index) => workerId(index + 1))
  }, {
    loadCrewContextsFn: async () => leaderContext(),
    registerArrivalFn: async (_db, input) => {
      calls.push(input);
      return recordedResult(input.assignmentId);
    },
    reviewAttendanceFn: async () => ({})
  });

  assert.equal(calls.length, 9);
  assert.equal(calls[0].assignmentId, LEADER_ASSIGNMENT_ID);
  assert.equal(calls.some((call) => call.assignmentId === assignmentId(10)), false);
  assert.equal(result.summary.totalMembers, 10);
  assert.equal(result.summary.eligibleMembers, 9);
  assert.equal(result.summary.notDetectedCount, 1);
  assert.equal(result.summary.processedCount, 9);
  assert.equal(result.summary.newlyRecordedCount, 9);
});

test('reintento completa al décimo y conserva los ocho ya registrados fuera del nuevo scan', async () => {
  const members = Array.from({ length: 10 }, (_, index) => member(index + 1, index >= 1 && index <= 8));
  const calls = [];
  const prisma = {
    dispatchAssignment: { findMany: async () => members }
  };

  const result = await registerCrewArrivalForLeader(prisma, {
    leaderWorkerId: LEADER_WORKER_ID,
    assignmentId: LEADER_ASSIGNMENT_ID,
    idempotencyKey: 'TEST-CREW-ATTEMPT-0002',
    now: SERVER_NOW,
    captureMode: 'OFFLINE_WEB',
    clientCapturedAt: new Date(CAPTURED_AT.getTime() + 5 * 60 * 1000),
    latitude: 4.60,
    longitude: -74.08,
    accuracyMeters: 12,
    installationIdHash: 'TEST-INSTALL-HASH-01',
    presenceValidated: true,
    validatedWorkerIds: [LEADER_WORKER_ID, workerId(10)]
  }, {
    loadCrewContextsFn: async () => leaderContext(),
    registerArrivalFn: async (_db, input) => {
      calls.push(input);
      return input.assignmentId === LEADER_ASSIGNMENT_ID
        ? duplicateResult(input.assignmentId)
        : recordedResult(input.assignmentId);
    },
    reviewAttendanceFn: async () => ({})
  });

  assert.deepEqual(calls.map((call) => call.assignmentId), [LEADER_ASSIGNMENT_ID, assignmentId(10)]);
  assert.equal(result.summary.previouslyRecordedCount, 8);
  assert.equal(result.summary.alreadyRecordedCount, 9);
  assert.equal(result.summary.newlyRecordedCount, 1);
  assert.equal(result.summary.processedCount, 10);
  assert.equal(result.summary.notDetectedCount, 0);
  assert.equal(result.summary.failedCount, 0);
});

test('cola grupal reutiliza el mismo IndexedDB/service worker, prueba ubicación nativa y no crea otro escritor', async () => {
  const [offline, serviceWorker, nativePresence, portalRoute, groupArrival, presenceBridge] = await Promise.all([
    readFile(new URL('../src/public/worker-portal-offline.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/worker-portal-sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../mobile/android/app/src/main/assets/native-presence.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-attendance/application/registerCrewArrival.js', import.meta.url), 'utf8'),
    readFile(new URL('../mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java', import.meta.url), 'utf8')
  ]);

  for (const source of [offline, serviceWorker]) {
    assert.match(source, /DB_NAME = 'lorren-worker-portal-v1'/);
    assert.match(source, /DB_VERSION = 2/);
    assert.match(source, /crewPresenceQueue/);
    assert.match(source, /crewPresenceReceipts/);
    assert.match(source, /lorren-worker-arrivals/);
  }
  assert.match(serviceWorker, /\/cuadrillas\/presencia\/sincronizar/);
  assert.match(serviceWorker, /CREW_PRESENCE_SYNCED/);
  assert.match(serviceWorker, /syncAll/);
  assert.match(serviceWorker, /X-Requested-With': 'worker-portal'/);
  assert.doesNotMatch(serviceWorker, /punctualityStatus,\s*\n/);
  assert.match(nativePresence, /queueCrewPresence/);
  assert.match(nativePresence, /Marcar llegada de toda la cuadrilla/);
  assert.match(nativePresence, /Reintentar no detectados/);
  assert.match(presenceBridge, /Location\.isMock\(\)/);
  assert.match(presenceBridge, /isFromMockProvider\(\)/);
  assert.match(presenceBridge, /leaderLocationProof/);
  assert.match(presenceBridge, /"attendanceWriter", false/);
  assert.match(portalRoute, /verifyCrewPresenceBundle/);
  assert.match(portalRoute, /verified\.leaderLocation/);
  assert.match(portalRoute, /clientCapturedAt: verified\.clientCapturedAt/);
  assert.match(groupArrival, /registerDispatchArrival/);
  assert.doesNotMatch(nativePresence, /registerDispatchArrival|registerCrewArrivalForLeader/);
  assert.doesNotMatch(nativePresence, /alert\s*\(|confirm\s*\(|prompt\s*\(/);
});
