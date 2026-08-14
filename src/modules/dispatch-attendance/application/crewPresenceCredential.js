import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature
} from 'node:crypto';
import { ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } from './registerArrival.js';
import { loadCrewAttendancePortalContexts } from './crewAttendanceConfig.js';

const CREDENTIAL_VERSION = 'cp1';
const CREDENTIAL_AUDIENCE = 'lorren-crew-presence';
const CREDENTIAL_HMAC_CONTEXT = 'lorren-crew-presence-credential-v1';
const PROOF_CONTEXT = 'lorren-presence-v1';
const DEFAULT_CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CREDENTIAL_TTL_MS = 15 * 60 * 1000;
const MAX_CREDENTIAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROOF_COUNT = 200;
const MAX_PROOF_CLOCK_DELTA_MS = 10 * 60 * 1000;
const MAX_PUBLIC_KEY_BYTES = 1024;
const MAX_SIGNATURE_BYTES = 256;

function requireString(value, label, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label}_invalid`);
  return normalized;
}

function requireDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function normalizeTtl(value) {
  const ttl = value === undefined || value === null ? DEFAULT_CREDENTIAL_TTL_MS : Number(value);
  if (!Number.isInteger(ttl) || ttl < MIN_CREDENTIAL_TTL_MS || ttl > MAX_CREDENTIAL_TTL_MS) {
    throw new Error('crew_presence_credential_ttl_invalid');
  }
  return ttl;
}

function decodeBase64(value, label, maxBytes) {
  const normalized = requireString(value, label, Math.ceil(maxBytes * 1.5));
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error(`${label}_invalid`);
  const bytes = Buffer.from(normalized, 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw new Error(`${label}_invalid`);
  return bytes;
}

function parsePresencePublicKey(publicKeyBase64) {
  const encoded = decodeBase64(publicKeyBase64, 'crew_presence_public_key', MAX_PUBLIC_KEY_BYTES);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: encoded, format: 'der', type: 'spki' });
  } catch {
    throw new Error('crew_presence_public_key_invalid');
  }
  if (publicKey.asymmetricKeyType !== 'ec') throw new Error('crew_presence_public_key_invalid');
  const curve = publicKey.asymmetricKeyDetails?.namedCurve;
  if (curve && !['prime256v1', 'secp256r1'].includes(curve)) {
    throw new Error('crew_presence_public_key_invalid');
  }
  return { encoded, publicKey };
}

function publicKeyHash(encoded) {
  return createHash('sha256').update(encoded).digest('base64url');
}

function resolveSecret(options = {}) {
  const env = options.env || process.env;
  const candidate = options.secret
    ?? env.ATTENDANCE_CREW_PRESENCE_SECRET
    ?? env.ATTENDANCE_PORTAL_HANDOFF_SECRET
    ?? env.ATTENDANCE_INSTALLATION_PEPPER;
  const secret = typeof candidate === 'string' ? candidate.trim() : '';
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('crew_presence_secret_required');
  return secret;
}

function credentialSignature(encodedPayload, secret) {
  return createHmac('sha256', secret)
    .update(CREDENTIAL_HMAC_CONTEXT, 'utf8')
    .update('\0', 'utf8')
    .update(encodedPayload, 'utf8')
    .digest();
}

function parseCredentialToken(value) {
  const token = requireString(value, 'crew_presence_credential', 4096);
  const parts = token.split('.');
  if (
    parts.length !== 3
    || parts[0] !== CREDENTIAL_VERSION
    || !/^[A-Za-z0-9_-]+$/.test(parts[1])
    || !/^[A-Za-z0-9_-]+$/.test(parts[2])
  ) {
    throw new Error('crew_presence_credential_invalid');
  }
  return parts;
}

function parseCredentialPayload(encodedPayload) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('crew_presence_credential_invalid');
  }
  if (
    payload?.v !== 1
    || payload?.aud !== CREDENTIAL_AUDIENCE
    || typeof payload.workerId !== 'string'
    || typeof payload.deviceId !== 'string'
    || typeof payload.keyHash !== 'string'
    || !Number.isFinite(payload.iat)
    || !Number.isFinite(payload.exp)
    || payload.exp <= payload.iat
    || payload.exp - payload.iat > MAX_CREDENTIAL_TTL_MS
  ) {
    throw new Error('crew_presence_credential_invalid');
  }
  return payload;
}

export function issueCrewPresenceCredential(input = {}, options = {}) {
  const workerId = requireString(input.workerId, 'crew_presence_worker_id', 160);
  const deviceId = requireString(input.deviceId, 'crew_presence_device_id', 160);
  const now = requireDate(input.now ?? new Date(), 'crew_presence_now');
  const ttlMs = normalizeTtl(options.ttlMs);
  const { encoded } = parsePresencePublicKey(input.publicKey);
  const payload = {
    v: 1,
    aud: CREDENTIAL_AUDIENCE,
    workerId,
    deviceId,
    keyHash: publicKeyHash(encoded),
    iat: now.getTime(),
    exp: now.getTime() + ttlMs
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = credentialSignature(encodedPayload, resolveSecret(options)).toString('base64url');
  return {
    credential: `${CREDENTIAL_VERSION}.${encodedPayload}.${signature}`,
    expiresAt: new Date(payload.exp),
    keyHash: payload.keyHash
  };
}

export function readCrewPresenceCredential(input = {}, options = {}) {
  const at = requireDate(input.at ?? new Date(), 'crew_presence_credential_at');
  const [, encodedPayload, encodedSignature] = parseCredentialToken(input.credential);
  const expected = credentialSignature(encodedPayload, resolveSecret(options));
  let observed;
  try {
    observed = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new Error('crew_presence_credential_invalid');
  }
  if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) {
    throw new Error('crew_presence_credential_invalid');
  }
  const payload = parseCredentialPayload(encodedPayload);
  if (at.getTime() < payload.iat - 60_000 || at.getTime() > payload.exp) {
    throw new Error('crew_presence_credential_expired');
  }
  return payload;
}

export function buildCrewPresenceCanonicalProof(input = {}) {
  const attemptId = requireString(input.attemptId, 'crew_presence_attempt_id', 160);
  const serviceRequestId = requireString(input.serviceRequestId, 'crew_presence_service_request_id', 160);
  const challenge = requireString(input.challenge, 'crew_presence_challenge', 2048);
  const respondedAt = Number(input.respondedAt);
  if (!Number.isFinite(respondedAt) || respondedAt <= 0) throw new Error('crew_presence_responded_at_invalid');
  return `${PROOF_CONTEXT}\n${attemptId}\n${serviceRequestId}\n${challenge}\n${Math.trunc(respondedAt)}`;
}

function requirePrisma(prisma) {
  if (!prisma?.dispatchAssignment || typeof prisma.dispatchAssignment.findMany !== 'function') {
    throw new Error('crew_presence_assignment_contract_invalid');
  }
  if (!prisma?.dispatchWorkerDevice || typeof prisma.dispatchWorkerDevice.findMany !== 'function') {
    throw new Error('crew_presence_device_contract_invalid');
  }
  return prisma;
}

function deviceActiveAt(device, at) {
  const authorizedFrom = device?.authorizedFrom instanceof Date
    ? device.authorizedFrom
    : new Date(device?.authorizedFrom);
  const authorizedUntil = device?.authorizedUntil == null
    ? null
    : (device.authorizedUntil instanceof Date ? device.authorizedUntil : new Date(device.authorizedUntil));
  if (Number.isNaN(authorizedFrom.getTime()) || authorizedFrom.getTime() > at.getTime()) return false;
  return !authorizedUntil || (!Number.isNaN(authorizedUntil.getTime()) && authorizedUntil.getTime() >= at.getTime());
}

function verifyProofSignatureValue(proof, credentialPayload) {
  const { encoded, publicKey } = parsePresencePublicKey(proof.publicKey);
  if (publicKeyHash(encoded) !== credentialPayload.keyHash) return false;
  const canonical = buildCrewPresenceCanonicalProof(proof);
  const signature = decodeBase64(proof.signature, 'crew_presence_signature', MAX_SIGNATURE_BYTES);
  try {
    return verifySignature('sha256', Buffer.from(canonical, 'utf8'), publicKey, signature);
  } catch {
    return false;
  }
}

function normalizeProofBundle(input, expected = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('crew_presence_bundle_invalid');
  }
  const attemptId = requireString(input.attemptId, 'crew_presence_attempt_id', 160);
  const serviceRequestId = requireString(input.serviceRequestId, 'crew_presence_service_request_id', 160);
  const challenge = requireString(input.challenge, 'crew_presence_challenge', 2048);
  const challengeSentAt = Number(input.challengeSentAt);
  if (!Number.isFinite(challengeSentAt) || challengeSentAt <= 0) {
    throw new Error('crew_presence_challenge_sent_at_invalid');
  }
  if (expected.attemptId && attemptId !== expected.attemptId) throw new Error('crew_presence_attempt_mismatch');
  if (expected.serviceRequestId && serviceRequestId !== expected.serviceRequestId) {
    throw new Error('crew_presence_service_request_mismatch');
  }
  const proofs = Array.isArray(input.proofs) ? input.proofs : [];
  if (proofs.length > MAX_PROOF_COUNT) throw new Error('crew_presence_proof_count_invalid');
  return { attemptId, serviceRequestId, challenge, challengeSentAt, proofs };
}

export async function verifyCrewPresenceBundle(prisma, input = {}, options = {}) {
  requirePrisma(prisma);
  const leaderWorkerId = requireString(input.leaderWorkerId, 'crew_presence_leader_worker_id', 160);
  const leaderDeviceId = requireString(input.leaderDeviceId, 'crew_presence_leader_device_id', 160);
  const assignmentId = requireString(input.assignmentId, 'crew_presence_assignment_id', 160);
  const serviceRequestId = requireString(input.serviceRequestId, 'crew_presence_service_request_id', 160);
  const idempotencyKey = requireString(input.idempotencyKey, 'crew_presence_idempotency_key', 160);
  const now = requireDate(input.now ?? new Date(), 'crew_presence_now');
  const capturedAt = requireDate(input.clientCapturedAt, 'crew_presence_captured_at');
  const bundle = normalizeProofBundle(input.proofBundle, {
    attemptId: idempotencyKey,
    serviceRequestId
  });
  if (Math.abs(bundle.challengeSentAt - capturedAt.getTime()) > MAX_PROOF_CLOCK_DELTA_MS) {
    throw new Error('crew_presence_challenge_time_invalid');
  }

  const loadCrewContextsFn = options.loadCrewContextsFn || loadCrewAttendancePortalContexts;
  const contexts = await loadCrewContextsFn(prisma, { workerId: leaderWorkerId });
  const leaderContext = (Array.isArray(contexts) ? contexts : [])
    .find((context) => context?.assignmentId === assignmentId);
  if (
    !leaderContext
    || leaderContext.serviceRequestId !== serviceRequestId
    || leaderContext.mode !== 'CREW'
    || leaderContext.isCrewLeader !== true
    || leaderContext.crewAvailable !== true
  ) {
    throw new Error('crew_presence_leader_not_available');
  }

  const members = await prisma.dispatchAssignment.findMany({
    where: {
      serviceRequestId,
      status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
    },
    select: { id: true, workerId: true },
    orderBy: { createdAt: 'asc' }
  });
  if (!members.some((member) => member.id === assignmentId && member.workerId === leaderWorkerId)) {
    throw new Error('crew_presence_leader_not_assigned');
  }
  const memberWorkerIds = new Set(members.map((member) => member.workerId));

  const candidates = [];
  let rejectedProofCount = 0;
  for (const rawProof of bundle.proofs) {
    try {
      if (!rawProof || typeof rawProof !== 'object' || Array.isArray(rawProof)) throw new Error('proof_invalid');
      const proof = {
        attemptId: requireString(rawProof.attemptId, 'crew_presence_attempt_id', 160),
        serviceRequestId: requireString(rawProof.serviceRequestId, 'crew_presence_service_request_id', 160),
        challenge: requireString(rawProof.challenge, 'crew_presence_challenge', 2048),
        respondedAt: Number(rawProof.respondedAt),
        publicKey: requireString(rawProof.publicKey, 'crew_presence_public_key', 4096),
        signature: requireString(rawProof.signature, 'crew_presence_signature', 1024),
        credential: requireString(rawProof.credential, 'crew_presence_credential', 4096)
      };
      if (
        proof.attemptId !== bundle.attemptId
        || proof.serviceRequestId !== bundle.serviceRequestId
        || proof.challenge !== bundle.challenge
        || !Number.isFinite(proof.respondedAt)
        || Math.abs(proof.respondedAt - capturedAt.getTime()) > MAX_PROOF_CLOCK_DELTA_MS
      ) {
        throw new Error('proof_context_invalid');
      }
      const respondedAt = new Date(proof.respondedAt);
      const credential = readCrewPresenceCredential(
        { credential: proof.credential, at: respondedAt },
        options
      );
      if (
        credential.workerId === leaderWorkerId
        || !memberWorkerIds.has(credential.workerId)
        || !verifyProofSignatureValue(proof, credential)
      ) {
        throw new Error('proof_identity_invalid');
      }
      candidates.push({
        workerId: credential.workerId,
        deviceId: credential.deviceId,
        respondedAt
      });
    } catch {
      rejectedProofCount += 1;
    }
  }

  const deviceIds = [...new Set([leaderDeviceId, ...candidates.map((item) => item.deviceId)])];
  const devices = deviceIds.length
    ? await prisma.dispatchWorkerDevice.findMany({
        where: {
          id: { in: deviceIds },
          status: 'ACTIVE',
          authorizationType: 'PRIMARY',
          revokedAt: null,
          authorizedFrom: { lte: now },
          OR: [{ authorizedUntil: null }, { authorizedUntil: { gte: now } }]
        },
        select: {
          id: true,
          workerId: true,
          installationIdHash: true,
          authorizedFrom: true,
          authorizedUntil: true
        }
      })
    : [];
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const leaderDevice = deviceById.get(leaderDeviceId);
  if (!leaderDevice || leaderDevice.workerId !== leaderWorkerId || !deviceActiveAt(leaderDevice, capturedAt)) {
    throw new Error('crew_presence_leader_device_inactive');
  }

  const validatedWorkerIds = [leaderWorkerId];
  const seenWorkers = new Set(validatedWorkerIds);
  for (const candidate of candidates) {
    const device = deviceById.get(candidate.deviceId);
    if (
      !device
      || device.workerId !== candidate.workerId
      || !deviceActiveAt(device, candidate.respondedAt)
      || seenWorkers.has(candidate.workerId)
    ) {
      rejectedProofCount += 1;
      continue;
    }
    seenWorkers.add(candidate.workerId);
    validatedWorkerIds.push(candidate.workerId);
  }

  return {
    serviceRequestId,
    assignmentId,
    validatedWorkerIds,
    totalMembers: members.length,
    verifiedProofCount: Math.max(0, validatedWorkerIds.length - 1),
    rejectedProofCount,
    notDetectedCount: Math.max(0, members.length - validatedWorkerIds.length),
    leaderInstallationIdHash: leaderDevice.installationIdHash || null
  };
}
