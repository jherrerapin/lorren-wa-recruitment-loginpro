import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

export const WORKER_BIOMETRIC_ENTITY_TYPE = 'DISPATCH_WORKER_BIOMETRIC';
export const ATTENDANCE_BIOMETRIC_ENTITY_TYPE = 'DISPATCH_ATTENDANCE_BIOMETRIC';
export const WORKER_BIOMETRIC_MODEL_VERSION = 'human-3.3.6-faceres';
export const WORKER_BIOMETRIC_CONSENT_VERSION = 'attendance-biometric-v1';
export const WORKER_BIOMETRIC_ACTION = Object.freeze({
  ENROLLED: 'BIOMETRIC_ENROLLED',
  REVOKED: 'BIOMETRIC_REVOKED',
  ASSESSED: 'BIOMETRIC_ASSESSED'
});
export const WORKER_BIOMETRIC_CHALLENGE_ACTIONS = Object.freeze(['TURN_SIDE', 'MOVE_CLOSER']);

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MIN_DESCRIPTOR_LENGTH = 64;
const MAX_DESCRIPTOR_LENGTH = 2048;
const REAL_THRESHOLD = 0.55;
const LIVE_THRESHOLD = 0.55;
const MATCH_THRESHOLD = 0.52;

function normalizeString(value, maxLength = 500) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function biometricSecret(env = process.env) {
  const value = normalizeString(env.ATTENDANCE_BIOMETRIC_SECRET || env.ATTENDANCE_INSTALLATION_PEPPER, 4096);
  if (!value || value.length < 32) throw new Error('attendance_biometric_secret_required');
  return value;
}

function deriveKey(secret, purpose) {
  return createHmac('sha256', secret).update(`lorren:${purpose}:v1`).digest();
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function descriptorHash(descriptor) {
  return createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
}

export function normalizeWorkerBiometricDescriptor(value) {
  const candidate = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(candidate) || candidate.length < MIN_DESCRIPTOR_LENGTH || candidate.length > MAX_DESCRIPTOR_LENGTH) {
    throw new Error('attendance_biometric_descriptor_invalid');
  }
  return candidate.map((entry) => {
    const number = Number(entry);
    if (!Number.isFinite(number) || Math.abs(number) > 100) {
      throw new Error('attendance_biometric_descriptor_invalid');
    }
    return Math.round(number * 1_000_000) / 1_000_000;
  });
}

function encryptDescriptor(descriptor, env) {
  const iv = randomBytes(12);
  const key = deriveKey(biometricSecret(env), 'biometric-template-encryption');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(descriptor), 'utf8'), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: encrypted.toString('base64url')
  };
}

function decryptDescriptor(envelope, env) {
  if (!envelope || envelope.algorithm !== 'aes-256-gcm') throw new Error('attendance_biometric_template_invalid');
  const key = deriveKey(biometricSecret(env), 'biometric-template-encryption');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final()
  ]).toString('utf8');
  return normalizeWorkerBiometricDescriptor(JSON.parse(decrypted));
}

async function redactHistoricalEnrollmentTemplates(prisma, workerId, now) {
  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: WORKER_BIOMETRIC_ENTITY_TYPE,
      entityId: workerId,
      action: WORKER_BIOMETRIC_ACTION.ENROLLED
    },
    select: { id: true, metadata: true }
  });
  await Promise.all(events.map((event) => prisma.devAuditEvent.update({
    where: { id: event.id },
    data: {
      metadata: {
        ...(event.metadata && typeof event.metadata === 'object' ? event.metadata : {}),
        template: null,
        descriptorHash: null,
        redactedAt: now.toISOString()
      }
    }
  })));
}

async function findLatestEnrollmentEvent(prisma, workerId) {
  return prisma.devAuditEvent.findFirst({
    where: {
      entityType: WORKER_BIOMETRIC_ENTITY_TYPE,
      entityId: workerId,
      action: { in: [WORKER_BIOMETRIC_ACTION.ENROLLED, WORKER_BIOMETRIC_ACTION.REVOKED] }
    },
    orderBy: { createdAt: 'desc' }
  });
}

export async function loadWorkerBiometricStatusMap(prisma, workerIds = []) {
  const ids = [...new Set(workerIds.map((value) => normalizeString(value, 120)).filter(Boolean))];
  if (!ids.length) return new Map();
  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: WORKER_BIOMETRIC_ENTITY_TYPE,
      entityId: { in: ids },
      action: { in: [WORKER_BIOMETRIC_ACTION.ENROLLED, WORKER_BIOMETRIC_ACTION.REVOKED] }
    },
    orderBy: { createdAt: 'desc' }
  });
  const latest = new Map();
  events.forEach((event) => {
    if (event.entityId && !latest.has(event.entityId)) latest.set(event.entityId, event);
  });
  return new Map(ids.map((id) => {
    const event = latest.get(id) || null;
    return [id, {
      enrolled: event?.action === WORKER_BIOMETRIC_ACTION.ENROLLED,
      enrolledAt: event?.action === WORKER_BIOMETRIC_ACTION.ENROLLED ? event.createdAt : null,
      modelVersion: event?.metadata?.modelVersion || null
    }];
  }));
}

export async function enrollWorkerBiometric(prisma, input = {}, options = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const actorUsername = normalizeString(input.actorUsername, 160);
  const descriptor = normalizeWorkerBiometricDescriptor(input.descriptor);
  const consentAccepted = input.consentAccepted === true;
  const realScore = Number(input.realScore);
  const liveScore = Number(input.liveScore);
  if (!workerId || !actorUsername) throw new Error('attendance_biometric_enrollment_identity_required');
  if (!consentAccepted) throw new Error('attendance_biometric_consent_required');
  if (!Number.isFinite(realScore) || realScore < REAL_THRESHOLD) throw new Error('attendance_biometric_antispoof_low');
  if (!Number.isFinite(liveScore) || liveScore < LIVE_THRESHOLD) throw new Error('attendance_biometric_liveness_low');
  const now = options.now || new Date();
  if (!validDate(now)) throw new Error('attendance_biometric_enrollment_now_invalid');
  await redactHistoricalEnrollmentTemplates(prisma, workerId, now);
  const encrypted = encryptDescriptor(descriptor, options.env || process.env);
  const event = await prisma.devAuditEvent.create({
    data: {
      entityType: WORKER_BIOMETRIC_ENTITY_TYPE,
      entityId: workerId,
      entityLabel: normalizeString(input.workerLabel, 300),
      action: WORKER_BIOMETRIC_ACTION.ENROLLED,
      actorUsername,
      actorRole: normalizeString(input.actorRole, 80),
      actorSource: 'attendance-admin',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      metadata: {
        template: encrypted,
        descriptorHash: descriptorHash(descriptor),
        descriptorLength: descriptor.length,
        modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
        consentVersion: WORKER_BIOMETRIC_CONSENT_VERSION,
        consentAt: now.toISOString(),
        realScore,
        liveScore
      },
      createdAt: now
    }
  });
  return { enrolled: true, enrolledAt: event.createdAt, modelVersion: WORKER_BIOMETRIC_MODEL_VERSION };
}

export async function revokeWorkerBiometric(prisma, input = {}, options = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const actorUsername = normalizeString(input.actorUsername, 160);
  if (!workerId || !actorUsername) throw new Error('attendance_biometric_revocation_identity_required');
  const now = options.now || new Date();
  await redactHistoricalEnrollmentTemplates(prisma, workerId, now);
  const event = await prisma.devAuditEvent.create({
    data: {
      entityType: WORKER_BIOMETRIC_ENTITY_TYPE,
      entityId: workerId,
      entityLabel: normalizeString(input.workerLabel, 300),
      action: WORKER_BIOMETRIC_ACTION.REVOKED,
      actorUsername,
      actorRole: normalizeString(input.actorRole, 80),
      actorSource: 'attendance-admin',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      metadata: { reason: normalizeString(input.reason, 500) || 'ADMIN_REVOKED' },
      createdAt: now
    }
  });
  return { enrolled: false, revokedAt: event.createdAt };
}

export async function getWorkerBiometricEnrollment(prisma, workerId, options = {}) {
  const normalizedWorkerId = normalizeString(workerId, 120);
  if (!normalizedWorkerId) return { enrolled: false, descriptor: null };
  const event = await findLatestEnrollmentEvent(prisma, normalizedWorkerId);
  if (!event || event.action !== WORKER_BIOMETRIC_ACTION.ENROLLED) return { enrolled: false, descriptor: null };
  try {
    return {
      enrolled: true,
      descriptor: decryptDescriptor(event.metadata?.template, options.env || process.env),
      modelVersion: event.metadata?.modelVersion || null,
      enrolledAt: event.createdAt
    };
  } catch {
    return { enrolled: true, descriptor: null, templateInvalid: true };
  }
}

function challengeSignature(payload, env) {
  return createHmac('sha256', deriveKey(biometricSecret(env), 'biometric-challenge')).update(payload).digest('base64url');
}

export function issueWorkerBiometricChallenge(input = {}, options = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const assignmentId = normalizeString(input.assignmentId, 120);
  const idempotencyKey = normalizeString(input.idempotencyKey, 120);
  const markType = normalizeString(input.markType, 40)?.toUpperCase();
  if (!workerId || !assignmentId || !idempotencyKey || !['ARRIVAL', 'DEPARTURE'].includes(markType)) {
    throw new Error('attendance_biometric_challenge_input_invalid');
  }
  const now = options.now || new Date();
  if (!validDate(now)) throw new Error('attendance_biometric_challenge_now_invalid');
  const randomIndex = options.randomIndex ?? randomBytes(1)[0] % WORKER_BIOMETRIC_CHALLENGE_ACTIONS.length;
  const action = WORKER_BIOMETRIC_CHALLENGE_ACTIONS[randomIndex % WORKER_BIOMETRIC_CHALLENGE_ACTIONS.length];
  const payloadObject = {
    v: 1,
    workerId,
    assignmentId,
    idempotencyKey,
    markType,
    action,
    nonce: randomBytes(18).toString('base64url'),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString()
  };
  const payload = encode(JSON.stringify(payloadObject));
  return {
    token: `${payload}.${challengeSignature(payload, options.env || process.env)}`,
    action,
    expiresAt: payloadObject.expiresAt
  };
}

function verifyChallenge(token, expected = {}, options = {}) {
  const normalized = normalizeString(token, 8192);
  if (!normalized || !normalized.includes('.')) throw new Error('attendance_biometric_challenge_invalid');
  const [payload, signature] = normalized.split('.');
  const expectedSignature = challengeSignature(payload, options.env || process.env);
  const left = Buffer.from(signature || '', 'base64url');
  const right = Buffer.from(expectedSignature, 'base64url');
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('attendance_biometric_challenge_invalid');
  const value = JSON.parse(decode(payload));
  const now = options.now || new Date();
  if (!validDate(now) || new Date(value.expiresAt).getTime() < now.getTime()) throw new Error('attendance_biometric_challenge_expired');
  for (const key of ['workerId', 'assignmentId', 'idempotencyKey', 'markType']) {
    if (String(value[key]) !== String(expected[key])) throw new Error('attendance_biometric_challenge_mismatch');
  }
  return value;
}

export function humanFaceSimilarity(descriptor1, descriptor2, options = {}) {
  const left = normalizeWorkerBiometricDescriptor(descriptor1);
  const right = normalizeWorkerBiometricDescriptor(descriptor2);
  if (left.length !== right.length) return 0;
  const multiplier = Number(options.multiplier || 25);
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    distance += Math.abs((left[index] - right[index]) * multiplier) ** 2;
  }
  const root = Math.sqrt(distance);
  const min = Number(options.min ?? 0.2);
  const max = Number(options.max ?? 0.8);
  const normalized = (1 - (root / 100) - min) / (max - min);
  return Math.round(100 * Math.max(0, Math.min(1, normalized))) / 100;
}

function addFlag(flags, flag, points, state) {
  if (!flags.includes(flag)) flags.push(flag);
  state.score += points;
}

async function descriptorWasReplayed(prisma, hash, idempotencyKey) {
  const event = await prisma.devAuditEvent.findFirst({
    where: {
      entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
      entityId: { not: idempotencyKey },
      action: WORKER_BIOMETRIC_ACTION.ASSESSED,
      metadata: { path: ['descriptorHash'], equals: hash }
    },
    orderBy: { createdAt: 'desc' }
  }).catch(() => null);
  return Boolean(event);
}

export async function assessWorkerBiometric(prisma, input = {}, options = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const assignmentId = normalizeString(input.assignmentId, 120);
  const idempotencyKey = normalizeString(input.idempotencyKey, 120);
  const markType = normalizeString(input.markType, 40)?.toUpperCase();
  const now = options.now || new Date();
  if (!workerId || !assignmentId || !idempotencyKey || !['ARRIVAL', 'DEPARTURE'].includes(markType)) {
    throw new Error('attendance_biometric_assessment_input_invalid');
  }

  const existing = await prisma.devAuditEvent.findFirst({
    where: { entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE, entityId: idempotencyKey, action: WORKER_BIOMETRIC_ACTION.ASSESSED },
    orderBy: { createdAt: 'desc' }
  });
  if (existing?.metadata) return existing.metadata;

  const flags = [];
  const state = { score: 0 };
  const enrollment = await getWorkerBiometricEnrollment(prisma, workerId, options);
  let descriptor = null;
  let challenge = null;
  let similarity = null;
  let hash = null;
  const realScore = Number(input.realScore);
  const liveScore = Number(input.liveScore);

  if (!enrollment.enrolled) {
    addFlag(flags, 'BIOMETRIC_NOT_ENROLLED', 35, state);
  } else if (!enrollment.descriptor) {
    addFlag(flags, 'BIOMETRIC_TEMPLATE_UNAVAILABLE', 60, state);
  }

  try {
    challenge = verifyChallenge(input.challengeToken, { workerId, assignmentId, idempotencyKey, markType }, { ...options, now });
  } catch (error) {
    addFlag(flags, error?.message === 'attendance_biometric_challenge_expired' ? 'BIOMETRIC_CHALLENGE_EXPIRED' : 'BIOMETRIC_CHALLENGE_INVALID', 55, state);
  }

  if (challenge && (input.challengeCompleted !== true || input.challengeAction !== challenge.action)) {
    addFlag(flags, 'BIOMETRIC_CHALLENGE_NOT_COMPLETED', 55, state);
  }

  try {
    descriptor = normalizeWorkerBiometricDescriptor(input.descriptor);
    hash = descriptorHash(descriptor);
  } catch {
    addFlag(flags, 'BIOMETRIC_DESCRIPTOR_INVALID', 60, state);
  }

  if (!Number.isFinite(realScore) || realScore < REAL_THRESHOLD) addFlag(flags, 'BIOMETRIC_ANTISPOOF_LOW', 50, state);
  if (!Number.isFinite(liveScore) || liveScore < LIVE_THRESHOLD) addFlag(flags, 'BIOMETRIC_LIVENESS_LOW', 45, state);

  if (descriptor && enrollment.descriptor) {
    similarity = humanFaceSimilarity(enrollment.descriptor, descriptor);
    if (similarity < MATCH_THRESHOLD) addFlag(flags, 'BIOMETRIC_FACE_MISMATCH', 70, state);
    if (hash && await descriptorWasReplayed(prisma, hash, idempotencyKey)) {
      addFlag(flags, 'BIOMETRIC_DESCRIPTOR_REPLAY', 80, state);
    }
  }

  const decision = flags.length ? 'REVIEW_REQUIRED' : 'VERIFIED';
  const assessment = {
    decision,
    verified: decision === 'VERIFIED',
    riskScore: Math.min(100, state.score),
    riskFlags: flags,
    similarity,
    realScore: Number.isFinite(realScore) ? realScore : null,
    liveScore: Number.isFinite(liveScore) ? liveScore : null,
    challengeAction: challenge?.action || normalizeString(input.challengeAction, 40),
    challengeCompleted: input.challengeCompleted === true,
    descriptorHash: hash,
    modelVersion: normalizeString(input.modelVersion, 100) || WORKER_BIOMETRIC_MODEL_VERSION,
    assessedAt: now.toISOString()
  };

  await prisma.devAuditEvent.create({
    data: {
      entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
      entityId: idempotencyKey,
      entityLabel: assignmentId,
      action: WORKER_BIOMETRIC_ACTION.ASSESSED,
      actorSource: 'worker-portal',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      metadata: { ...assessment, workerId, assignmentId, markType },
      createdAt: now
    }
  });
  return assessment;
}
