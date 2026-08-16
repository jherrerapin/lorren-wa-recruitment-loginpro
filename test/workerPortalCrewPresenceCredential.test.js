import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign
} from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import express from 'express';
import {
  buildCrewNativeLocationCanonicalProof,
  buildCrewPresenceCanonicalProof,
  issueCrewPresenceCredential,
  readCrewPresenceCredential,
  verifyCrewPresenceBundle
} from '../src/modules/dispatch-attendance/application/crewPresenceCredential.js';
import { registerCrewArrivalForLeader } from '../src/modules/dispatch-attendance/application/registerCrewArrival.js';
import { loadCrewAttendancePortalContexts } from '../src/modules/dispatch-attendance/application/crewAttendanceConfig.js';
import { workerPortalRouter } from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const SECRET = 'TEST-crew-presence-secret-00000000000000000000000000000000';
const SERVICE_ID = 'TEST-SERVICE-CREW-01';
const LEADER_WORKER_ID = 'TEST-WORKER-01';
const LEADER_ASSIGNMENT_ID = 'TEST-ASSIGNMENT-01';
const LEADER_DEVICE_ID = 'TEST-DEVICE-01';
const ATTEMPT_ID = 'TEST-CREW-ATTEMPT-0001';
const CHALLENGE = 'TEST-CHALLENGE-000000000000000000000000000001';
const CAPTURED_AT = new Date('2026-08-14T18:00:00-05:00');
const SERVER_NOW = new Date('2026-08-14T20:00:00-05:00');
const SESSION_TOKEN = 'S'.repeat(43);

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

function presenceBundle({ proofs = [], phoneExceptions = [], attemptId = ATTEMPT_ID, challenge = CHALLENGE, capturedAt = CAPTURED_AT } = {}) {
  return {
    version: 1,
    attemptId,
    serviceRequestId: SERVICE_ID,
    challenge,
    challengeSentAt: capturedAt.getTime(),
    leaderLocationProof: createLeaderLocationProof({
      attemptId,
      capturedAt: capturedAt.getTime()
    }),
    proofs,
    phoneExceptions
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
    proofBundle: presenceBundle({ proofs }),
    now: SERVER_NOW
  }, {
    secret: SECRET,
    loadCrewContextsFn: async () => leaderContext()
  });

  assert.deepEqual(verified.validatedWorkerIds, Array.from({ length: 9 }, (_, index) => workerId(index + 1)));
  assert.deepEqual(verified.phoneExceptionWorkerIds, []);
  assert.equal(verified.totalMembers, 10);
  assert.equal(verified.members.length, 10);
  assert.equal(verified.verifiedProofCount, 8);
  assert.equal(verified.notDetectedCount, 1);
  assert.equal(verified.rejectedProofCount, 0);
  assert.equal(verified.rejectedPhoneExceptionCount, 0);
  assert.equal(verified.leaderInstallationIdHash, 'TEST-INSTALL-HASH-01');
  assert.deepEqual(verified.leaderLocation, {
    latitude: 4.6,
    longitude: -74.08,
    accuracyMeters: 12,
    clientCapturedAt: CAPTURED_AT.toISOString()
  });
});

test('10 asignados: el décimo sin teléfono queda como excepción y nunca entra a validatedWorkerIds', async () => {
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
    proofBundle: presenceBundle({
      proofs,
      phoneExceptions: [{ workerId: workerId(10), reason: 'NO_PHONE_AVAILABLE' }]
    }),
    now: SERVER_NOW
  }, {
    secret: SECRET,
    loadCrewContextsFn: async () => leaderContext()
  });

  assert.deepEqual(verified.validatedWorkerIds, Array.from({ length: 9 }, (_, index) => workerId(index + 1)));
  assert.deepEqual(verified.phoneExceptionWorkerIds, [workerId(10)]);
  assert.equal(verified.validatedWorkerIds.includes(workerId(10)), false);
  assert.equal(verified.notDetectedCount, 0);
  assert.equal(verified.rejectedPhoneExceptionCount, 0);
});

test('un proof válido siempre gana sobre una declaración sin teléfono del mismo auxiliar', async () => {
  const members = [member(1), member(2)];
  const proof = createProof(2);
  const prisma = createVerifyPrisma({
    members,
    devices: [activeDevice(1), activeDevice(2)]
  });

  const verified = await verifyCrewPresenceBundle(prisma, {
    leaderWorkerId: LEADER_WORKER_ID,
    leaderDeviceId: LEADER_DEVICE_ID,
    assignmentId: LEADER_ASSIGNMENT_ID,
    serviceRequestId: SERVICE_ID,
    idempotencyKey: ATTEMPT_ID,
    clientCapturedAt: CAPTURED_AT,
    proofBundle: presenceBundle({
      proofs: [proof],
      phoneExceptions: [{ workerId: workerId(2), reason: 'NO_PHONE_AVAILABLE' }]
    }),
    now: SERVER_NOW
  }, {
    secret: SECRET,
    loadCrewContextsFn: async () => leaderContext()
  });

  assert.deepEqual(verified.validatedWorkerIds, [LEADER_WORKER_ID, workerId(2)]);
  assert.deepEqual(verified.phoneExceptionWorkerIds, []);
  assert.equal(verified.rejectedPhoneExceptionCount, 1);
  assert.equal(verified.notDetectedCount, 0);
});

test('una excepción ajena a la cuadrilla o aplicada al encargado nunca se acepta', async () => {
  const members = [member(1), member(2)];
  const prisma = createVerifyPrisma({ members, devices: [activeDevice(1)] });

  const verified = await verifyCrewPresenceBundle(prisma, {
    leaderWorkerId: LEADER_WORKER_ID,
    leaderDeviceId: LEADER_DEVICE_ID,
    assignmentId: LEADER_ASSIGNMENT_ID,
    serviceRequestId: SERVICE_ID,
    idempotencyKey: ATTEMPT_ID,
    clientCapturedAt: CAPTURED_AT,
    proofBundle: presenceBundle({
      phoneExceptions: [
        { workerId: LEADER_WORKER_ID, reason: 'NO_PHONE_AVAILABLE' },
        { workerId: 'TEST-WORKER-OUTSIDE', reason: 'NO_PHONE_AVAILABLE' }
      ]
    }),
    now: SERVER_NOW
  }, {
    secret: SECRET,
    loadCrewContextsFn: async () => leaderContext()
  });

  assert.deepEqual(verified.phoneExceptionWorkerIds, []);
  assert.equal(verified.rejectedPhoneExceptionCount, 2);
  assert.equal(verified.notDetectedCount, 1);
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
    proofBundle: presenceBundle({ proofs: [invalidSignature, outsider, missingDevice] }),
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
        ...presenceBundle(),
        leaderLocationProof: createLeaderLocationProof({ isMock: true })
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
        ...presenceBundle(),
        leaderLocationProof: invalidLocation
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
    proofBundle: presenceBundle({
      proofs: [proof],
      attemptId: retryAttemptId,
      challenge: retryChallenge,
      capturedAt: retryCapturedAt
    }),
    now: SERVER_NOW
  }, {
    secret: SECRET,
    loadCrewContextsFn: async () => leaderContext()
  });

  assert.deepEqual(verified.validatedWorkerIds, [LEADER_WORKER_ID, workerId(10)]);
  assert.equal(verified.notDetectedCount, 0);
});

test('el contexto del Portal entrega la lista mínima solo al encargado de esa cuadrilla', async () => {
  const operationPointId = 'TEST-OPERATION-01';
  const serviceCreatedAt = new Date('2026-08-14T10:00:00.000Z');
  const service = {
    id: SERVICE_ID,
    operationPointId,
    createdAt: serviceCreatedAt,
    operationPoint: { id: operationPointId, isActive: true, attendanceEnabled: true },
    assignments: [
      {
        id: assignmentId(1),
        workerId: workerId(1),
        worker: { fullName: 'Auxiliar Prueba 01' },
        attendanceSession: null
      },
      {
        id: assignmentId(2),
        workerId: workerId(2),
        worker: { fullName: 'Auxiliar Prueba 02' },
        attendanceSession: { arrivalReportedAt: CAPTURED_AT }
      }
    ]
  };
  const prisma = {
    dispatchAssignment: {
      findMany: async ({ where }) => [{
        id: where.workerId === LEADER_WORKER_ID ? assignmentId(1) : assignmentId(2),
        workerId: where.workerId,
        serviceRequest: service
      }]
    },
    devAuditEvent: {
      findMany: async ({ where }) => {
        if (where.entityType === 'DISPATCH_CREW_ATTENDANCE_OPERATION') {
          return [{
            entityId: operationPointId,
            createdAt: new Date('2026-08-14T09:00:00.000Z'),
            metadata: { allowed: true }
          }];
        }
        return [{
          entityId: SERVICE_ID,
          createdAt: new Date('2026-08-14T10:01:00.000Z'),
          metadata: { mode: 'CREW', crewLeaderWorkerId: LEADER_WORKER_ID }
        }];
      }
    }
  };

  const leader = await loadCrewAttendancePortalContexts(prisma, { workerId: LEADER_WORKER_ID });
  const auxiliary = await loadCrewAttendancePortalContexts(prisma, { workerId: workerId(2) });

  assert.equal(leader[0].isCrewLeader, true);
  assert.deepEqual(leader[0].members, [
    {
      assignmentId: assignmentId(1),
      workerId: workerId(1),
      displayName: 'Auxiliar Prueba 01',
      arrivalReported: false,
      isLeader: true
    },
    {
      assignmentId: assignmentId(2),
      workerId: workerId(2),
      displayName: 'Auxiliar Prueba 02',
      arrivalReported: true,
      isLeader: false
    }
  ]);
  assert.equal(auxiliary[0].isCrewLeader, false);
  assert.deepEqual(auxiliary[0].members, []);
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

test('una excepción sin teléfono no se convierte en llamada al escritor canónico', async () => {
  const members = Array.from({ length: 10 }, (_, index) => member(index + 1));
  const calls = [];
  const validatedWorkerIds = Array.from({ length: 9 }, (_, index) => workerId(index + 1));
  const prisma = { dispatchAssignment: { findMany: async () => members } };

  await registerCrewArrivalForLeader(prisma, {
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
    validatedWorkerIds
  }, {
    loadCrewContextsFn: async () => leaderContext(),
    registerArrivalFn: async (_db, input) => {
      calls.push(input.assignmentId);
      return recordedResult(input.assignmentId);
    },
    reviewAttendanceFn: async () => ({})
  });

  assert.equal(calls.includes(assignmentId(10)), false);
  assert.equal(calls.length, 9);
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

test('sincronización devuelve estados individuales y audita la excepción sin entregarla al escritor', async () => {
  const operationPoint = {
    id: 'TEST-OPERATION-01',
    attendanceEnabled: true,
    attendanceLatitude: 4.6,
    attendanceLongitude: -74.08,
    geofenceRadiusMeters: 100,
    maxLocationAccuracyMeters: 50
  };
  const auditCalls = [];
  const registerCalls = [];
  const prisma = {
    devAuditEvent: {
      async upsert(input) {
        auditCalls.push(input);
        return input.create;
      }
    }
  };
  const verified = {
    serviceRequestId: SERVICE_ID,
    assignmentId: LEADER_ASSIGNMENT_ID,
    validatedWorkerIds: [LEADER_WORKER_ID, workerId(2)],
    phoneExceptionWorkerIds: [workerId(3)],
    members: [
      { assignmentId: assignmentId(1), workerId: workerId(1), arrivalReported: false },
      { assignmentId: assignmentId(2), workerId: workerId(2), arrivalReported: false },
      { assignmentId: assignmentId(3), workerId: workerId(3), arrivalReported: false }
    ],
    verifiedProofCount: 1,
    rejectedProofCount: 0,
    rejectedPhoneExceptionCount: 0,
    leaderInstallationIdHash: 'TEST-INSTALL-HASH-01',
    clientCapturedAt: CAPTURED_AT,
    leaderLocation: {
      latitude: 4.6,
      longitude: -74.08,
      accuracyMeters: 12,
      clientCapturedAt: CAPTURED_AT.toISOString()
    }
  };
  const app = express();
  app.use('/operaciones/portal', workerPortalRouter(prisma, {
    repository: {},
    nowFn: () => SERVER_NOW,
    resolveSessionFn: async () => ({
      workerId: LEADER_WORKER_ID,
      deviceId: LEADER_DEVICE_ID,
      sessionId: 'TEST-SESSION-PORTAL-01',
      expiresAt: new Date(SERVER_NOW.getTime() + 60 * 60 * 1000)
    }),
    loadAssignmentsFn: async () => [],
    loadBiometricAssignmentFn: async () => ({
      id: LEADER_ASSIGNMENT_ID,
      workerId: LEADER_WORKER_ID,
      serviceRequest: { id: SERVICE_ID, operationPoint }
    }),
    verifyCrewPresenceBundleFn: async () => verified,
    registerCrewPresenceArrivalFn: async (input) => {
      registerCalls.push(input);
      return {
        applied: true,
        summary: {
          totalMembers: 3,
          eligibleMembers: 2,
          newlyRecordedCount: 2,
          replayedCount: 0,
          alreadyRecordedCount: 0,
          failedCount: 0,
          reviewPendingCount: 0,
          notDetectedCount: 1,
          results: [
            { assignmentId: assignmentId(1), status: 'RECORDED' },
            { assignmentId: assignmentId(2), status: 'RECORDED' }
          ]
        }
      };
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = () => fetch(`${origin}/operaciones/portal/cuadrillas/presencia/sincronizar`, {
    method: 'POST',
    headers: {
      Cookie: `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${SESSION_TOKEN}`,
      'X-Requested-With': 'worker-portal',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      assignmentId: LEADER_ASSIGNMENT_ID,
      serviceRequestId: SERVICE_ID,
      idempotencyKey: ATTEMPT_ID,
      clientCapturedAt: CAPTURED_AT.toISOString(),
      proofBundle: { version: 1 }
    })
  });

  try {
    const firstResponse = await request();
    const firstPayload = await firstResponse.json();
    const secondResponse = await request();
    const secondPayload = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstPayload.requiresReview, true);
    assert.equal(firstPayload.phoneExceptionCount, 1);
    assert.equal(firstPayload.notDetectedCount, 0);
    assert.deepEqual(firstPayload.memberStatuses, [
      { assignmentId: assignmentId(1), workerId: workerId(1), isLeader: true, status: 'VERIFIED' },
      { assignmentId: assignmentId(2), workerId: workerId(2), isLeader: false, status: 'VERIFIED' },
      { assignmentId: assignmentId(3), workerId: workerId(3), isLeader: false, status: 'NO_PHONE_REVIEW' }
    ]);
    assert.deepEqual(secondPayload.memberStatuses, firstPayload.memberStatuses);
    assert.equal(registerCalls.length, 2);
    assert.deepEqual(registerCalls[0].validatedWorkerIds, [LEADER_WORKER_ID, workerId(2)]);
    assert.equal(registerCalls[0].validatedWorkerIds.includes(workerId(3)), false);
    assert.equal(auditCalls.length, 2);
    assert.equal(auditCalls[0].where.id, auditCalls[1].where.id);
    assert.equal(auditCalls[0].create.action, 'CREW_PHONE_EXCEPTION_DECLARED');
    assert.equal(auditCalls[0].create.metadata.workerId, workerId(3));
    assert.equal(auditCalls[0].create.metadata.reviewRequired, true);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('cola grupal reutiliza el mismo IndexedDB/service worker, prueba ubicación nativa y no crea otro escritor', async () => {
  const [offline, serviceWorker, nativePresence, portalRoute, groupArrival, presenceBridge, crewConfig] = await Promise.all([
    readFile(new URL('../src/public/worker-portal-offline.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/worker-portal-sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../mobile/android/app/src/main/assets/native-presence.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-attendance/application/registerCrewArrival.js', import.meta.url), 'utf8'),
    readFile(new URL('../mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-attendance/application/crewAttendanceConfig.js', import.meta.url), 'utf8')
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
  assert.match(nativePresence, /Verificar presencia/);
  assert.match(nativePresence, /Reintentar no detectados/);
  assert.match(nativePresence, /Sin teléfono · por revisar/);
  assert.match(nativePresence, /Confirmar sin teléfono/);
  assert.match(nativePresence, /proofBundle\.phoneExceptions/);
  assert.match(nativePresence, /memberStatuses/);
  assert.match(nativePresence, /NO_PHONE_AVAILABLE/);
  assert.match(presenceBridge, /location\.isMock\(\)/);
  assert.match(presenceBridge, /isFromMockProvider\(\)/);
  assert.match(presenceBridge, /leaderLocationProof/);
  assert.match(presenceBridge, /"attendanceWriter", false/);
  assert.match(portalRoute, /verifyCrewPresenceBundle/);
  assert.match(portalRoute, /verified\.leaderLocation/);
  assert.match(portalRoute, /clientCapturedAt: verified\.clientCapturedAt/);
  assert.match(portalRoute, /CREW_PHONE_EXCEPTION_DECLARED/);
  assert.match(portalRoute, /devAuditEvent\.upsert/);
  assert.match(portalRoute, /memberStatuses/);
  assert.match(portalRoute, /NO_PHONE_REVIEW/);
  assert.match(crewConfig, /displayName:/);
  assert.match(crewConfig, /arrivalReported:/);
  assert.match(crewConfig, /members/);
  assert.match(groupArrival, /registerDispatchArrival/);
  assert.doesNotMatch(nativePresence, /registerDispatchArrival|registerCrewArrivalForLeader/);
  assert.doesNotMatch(nativePresence, /alert\s*\(|confirm\s*\(|prompt\s*\(/);

  const proofReceived = nativePresence.match(/if \(type === 'proof_received'\) \{([\s\S]*?)\n    \}/);
  assert.ok(proofReceived, 'falta manejar proof_received');
  assert.doesNotMatch(proofReceived[1], /VERIFIED|setMemberServerStatuses/);
  assert.match(proofReceived[1], /respuesta/);
});
