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
export const WORKER_BIOMETRIC_EVIDENCE_VERSION = 2;
export const WORKER_BIOMETRIC_ACTION = Object.freeze({
  ENROLLED: 'BIOMETRIC_ENROLLED',
  REVOKED: 'BIOMETRIC_REVOKED',
  ASSESSED: 'BIOMETRIC_ASSESSED'
});
export const WORKER_BIOMETRIC_CHALLENGE_ACTIONS = Object.freeze(['TURN_SIDE', 'MOVE_CLOSER']);

const CHALLENGE_TTL_MS = 3 * 60 * 1000;
const VERIFICATION_TTL_MS = 90 * 1000;
const MIN_DESCRIPTOR_LENGTH = 64;
const MAX_DESCRIPTOR_LENGTH = 2048;
const REAL_THRESHOLD = 0.55;
const LIVE_THRESHOLD = 0.55;
const MATCH_THRESHOLD = 0.82;
const SAMPLE_CONSISTENCY_THRESHOLD = 0.78;
const ACTION_SAMPLE_CONSISTENCY_THRESHOLD = 0.65;
const ACTION_IDENTITY_THRESHOLD = 0.65;
const ENROLLMENT_SAMPLE_COUNT = 3;
const VERIFICATION_SAMPLE_COUNT = 4;
const PASSIVE_VERIFICATION_SAMPLE_COUNT = 2;
const ACTION_SAMPLE_COUNT = 3;
const PASSIVE_CHALLENGE_KIND = 'MODEL_PASSIVE_LIVENESS_V2';
const MIN_CHALLENGE_DURATION_MS = 200;
const MAX_CHALLENGE_DURATION_MS = 12_000;
const MIN_CAPTURE_DURATION_MS = 700;
const MAX_CAPTURE_DURATION_MS = 45_000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_INITIAL_FAILURES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 30 * 1000;
const RATE_LIMIT_MAX_DELAY_MS = 5 * 60 * 1000;
const BIOMETRIC_MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);

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

function descriptorSequenceHash(descriptors) {
  return createHash('sha256').update(JSON.stringify(descriptors)).digest('hex');
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label}_invalid`);
  }
  return number;
}

function normalizeScoreArray(value, expectedLength, label) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`${label}_invalid`);
  }
  return value.map((entry) => finiteNumber(entry, label, { min: 0, max: 1 }));
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

function normalizeDescriptorSamples(value, expectedLength, label) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`${label}_invalid`);
  }
  const samples = value.map((entry) => normalizeWorkerBiometricDescriptor(entry));
  const length = samples[0]?.length || 0;
  if (!length || samples.some((entry) => entry.length !== length)) {
    throw new Error(`${label}_inconsistent`);
  }
  return samples;
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('attendance_biometric_descriptor_invalid');
  return vector.map((value) => Math.round((value / norm) * 1_000_000) / 1_000_000);
}

function averageDescriptors(descriptors) {
  const length = descriptors[0]?.length || 0;
  if (!length || descriptors.some((descriptor) => descriptor.length !== length)) {
    throw new Error('attendance_biometric_descriptor_samples_inconsistent');
  }
  const average = Array.from({ length }, (_, index) => (
    descriptors.reduce((sum, descriptor) => sum + descriptor[index], 0) / descriptors.length
  ));
  return normalizeVector(average);
}

export function humanFaceSimilarity(descriptor1, descriptor2) {
  const left = normalizeWorkerBiometricDescriptor(descriptor1);
  const right = normalizeWorkerBiometricDescriptor(descriptor2);
  if (left.length !== right.length) return 0;
  let dotProduct = 0;
  let leftNormSquared = 0;
  let rightNormSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
    leftNormSquared += left[index] ** 2;
    rightNormSquared += right[index] ** 2;
  }
  if (leftNormSquared <= 0 || rightNormSquared <= 0) return 0;
  const cosine = dotProduct / Math.sqrt(leftNormSquared * rightNormSquared);
  return Math.round(10_000 * Math.max(0, Math.min(1, cosine))) / 10_000;
}

function minimumSampleSimilarity(descriptors) {
  let minimum = 1;
  for (let left = 0; left < descriptors.length; left += 1) {
    for (let right = left + 1; right < descriptors.length; right += 1) {
      minimum = Math.min(minimum, humanFaceSimilarity(descriptors[left], descriptors[right]));
    }
  }
  return Math.round(minimum * 10_000) / 10_000;
}

function validateStrictSamples(input, expectedLength, prefix) {
  const descriptors = normalizeDescriptorSamples(
    input.sampleDescriptors,
    expectedLength,
    `attendance_biometric_${prefix}_samples`
  );
  const realScores = normalizeScoreArray(
    input.sampleRealScores,
    expectedLength,
    `attendance_biometric_${prefix}_real_scores`
  );
  const liveScores = normalizeScoreArray(
    input.sampleLiveScores,
    expectedLength,
    `attendance_biometric_${prefix}_live_scores`
  );
  if (realScores.some((score) => score < REAL_THRESHOLD)) {
    throw new Error('attendance_biometric_antispoof_low');
  }
  if (liveScores.some((score) => score < LIVE_THRESHOLD)) {
    throw new Error('attendance_biometric_liveness_low');
  }
  const minimumSimilarity = minimumSampleSimilarity(descriptors);
  if (minimumSimilarity < SAMPLE_CONSISTENCY_THRESHOLD) {
    throw new Error('attendance_biometric_samples_inconsistent');
  }
  return {
    descriptors,
    descriptor: averageDescriptors(descriptors),
    realScores,
    liveScores,
    realScore: Math.min(...realScores),
    liveScore: Math.min(...liveScores),
    minimumSimilarity,
    captureHash: descriptorSequenceHash(descriptors)
  };
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
        captureHash: null,
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
      modelVersion: event?.metadata?.modelVersion || null,
      evidenceVersion: Number(event?.metadata?.evidenceVersion || 1)
    }];
  }));
}

export async function enrollWorkerBiometric(prisma, input = {}, options = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const actorUsername = normalizeString(input.actorUsername, 160);
  const consentAccepted = input.consentAccepted === true;
  if (!workerId || !actorUsername) throw new Error('attendance_biometric_enrollment_identity_required');
  if (!consentAccepted) throw new Error('attendance_biometric_consent_required');

  const strictEvidence = Number(input.evidenceVersion) === WORKER_BIOMETRIC_EVIDENCE_VERSION;
  let descriptor;
  let realScore;
  let liveScore;
  let minimumSampleSimilarityValue = null;
  let captureHash = null;
  let sampleCount = 1;

  if (strictEvidence) {
    if (normalizeString(input.modelVersion, 100) !== WORKER_BIOMETRIC_MODEL_VERSION) {
      throw new Error('attendance_biometric_model_version_invalid');
    }
    const samples = validateStrictSamples(input, ENROLLMENT_SAMPLE_COUNT, 'enrollment');
    finiteNumber(input.captureDurationMs, 'attendance_biometric_enrollment_duration', {
      min: 500,
      max: MAX_CAPTURE_DURATION_MS
    });
    descriptor = samples.descriptor;
    realScore = samples.realScore;
    liveScore = samples.liveScore;
    minimumSampleSimilarityValue = samples.minimumSimilarity;
    captureHash = samples.captureHash;
    sampleCount = ENROLLMENT_SAMPLE_COUNT;
  } else {
    descriptor = normalizeWorkerBiometricDescriptor(input.descriptor);
    realScore = Number(input.realScore);
    liveScore = Number(input.liveScore);
    if (!Number.isFinite(realScore) || realScore < REAL_THRESHOLD) throw new Error('attendance_biometric_antispoof_low');
    if (!Number.isFinite(liveScore) || liveScore < LIVE_THRESHOLD) throw new Error('attendance_biometric_liveness_low');
  }

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
        captureHash,
        descriptorLength: descriptor.length,
        sampleCount,
        minimumSampleSimilarity: minimumSampleSimilarityValue,
        evidenceVersion: strictEvidence ? WORKER_BIOMETRIC_EVIDENCE_VERSION : 1,
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
  if (!normalizedWorkerId) return { enrolled: false, descriptor: null, evidenceVersion: null };
  const event = await findLatestEnrollmentEvent(prisma, normalizedWorkerId);
  if (!event || event.action !== WORKER_BIOMETRIC_ACTION.ENROLLED) {
    return { enrolled: false, descriptor: null, evidenceVersion: null };
  }
  try {
    return {
      enrolled: true,
      descriptor: decryptDescriptor(event.metadata?.template, options.env || process.env),
      modelVersion: event.metadata?.modelVersion || null,
      evidenceVersion: Number(event.metadata?.evidenceVersion || 1),
      enrolledAt: event.createdAt
    };
  } catch {
    return {
      enrolled: true,
      descriptor: null,
      evidenceVersion: Number(event.metadata?.evidenceVersion || 1),
      templateInvalid: true
    };
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
  if (!workerId || !assignmentId || !idempotencyKey || !BIOMETRIC_MARK_TYPES.has(markType)) {
    throw new Error('attendance_biometric_challenge_input_invalid');
  }
  const now = options.now || new Date();
  if (!validDate(now)) throw new Error('attendance_biometric_challenge_now_invalid');
  const randomIndex = options.randomIndex ?? randomBytes(1)[0] % WORKER_BIOMETRIC_CHALLENGE_ACTIONS.length;
  const action = WORKER_BIOMETRIC_CHALLENGE_ACTIONS[randomIndex % WORKER_BIOMETRIC_CHALLENGE_ACTIONS.length];
  const payloadObject = {
    v: WORKER_BIOMETRIC_EVIDENCE_VERSION,
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

function normalizeChallengeEvidence(value, expectedAction) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('attendance_biometric_challenge_evidence_invalid');
  }
  if (value.kind === PASSIVE_CHALLENGE_KIND && value.action === expectedAction) {
    return {
      kind: value.kind,
      action: value.action,
      frames: finiteNumber(value.frames, 'attendance_biometric_passive_frames', {
        min: PASSIVE_VERIFICATION_SAMPLE_COUNT,
        max: 10
      }),
      captureDurationMs: finiteNumber(value.captureDurationMs, 'attendance_biometric_capture_duration', {
        min: MIN_CAPTURE_DURATION_MS,
        max: MAX_CAPTURE_DURATION_MS
      })
    };
  }

  if (value.kind !== 'MODEL_AND_ACTIVE_CHALLENGE_V2' || value.action !== expectedAction) {
    throw new Error('attendance_biometric_challenge_evidence_invalid');
  }

  const actionDescriptors = normalizeDescriptorSamples(
    value.actionDescriptors,
    ACTION_SAMPLE_COUNT,
    'attendance_biometric_action_samples'
  );
  const actionRealScores = normalizeScoreArray(
    value.actionRealScores,
    ACTION_SAMPLE_COUNT,
    'attendance_biometric_action_real_scores'
  );
  const actionLiveScores = normalizeScoreArray(
    value.actionLiveScores,
    ACTION_SAMPLE_COUNT,
    'attendance_biometric_action_live_scores'
  );
  if (actionRealScores.some((score) => score < REAL_THRESHOLD)) {
    throw new Error('attendance_biometric_antispoof_low');
  }
  if (actionLiveScores.some((score) => score < LIVE_THRESHOLD)) {
    throw new Error('attendance_biometric_liveness_low');
  }
  const actionMinimumSimilarity = minimumSampleSimilarity(actionDescriptors);
  if (actionMinimumSimilarity < ACTION_SAMPLE_CONSISTENCY_THRESHOLD) {
    throw new Error('attendance_biometric_challenge_evidence_invalid');
  }

  const evidence = {
    kind: value.kind,
    action: value.action,
    baselineFrames: finiteNumber(value.baselineFrames, 'attendance_biometric_baseline_frames', { min: 2, max: 20 }),
    actionFrames: finiteNumber(value.actionFrames, 'attendance_biometric_action_frames', { min: ACTION_SAMPLE_COUNT, max: 40 }),
    finalFrames: finiteNumber(value.finalFrames, 'attendance_biometric_final_frames', { min: 2, max: 20 }),
    captureDurationMs: finiteNumber(value.captureDurationMs, 'attendance_biometric_capture_duration', {
      min: MIN_CAPTURE_DURATION_MS,
      max: MAX_CAPTURE_DURATION_MS
    }),
    challengeDurationMs: finiteNumber(value.challengeDurationMs, 'attendance_biometric_challenge_duration', {
      min: MIN_CHALLENGE_DURATION_MS,
      max: MAX_CHALLENGE_DURATION_MS
    }),
    baselineYaw: finiteNumber(value.baselineYaw, 'attendance_biometric_baseline_yaw', { min: -3.2, max: 3.2 }),
    actionYaw: finiteNumber(value.actionYaw, 'attendance_biometric_action_yaw', { min: -3.2, max: 3.2 }),
    finalYaw: finiteNumber(value.finalYaw, 'attendance_biometric_final_yaw', { min: -3.2, max: 3.2 }),
    baselineFaceRatio: finiteNumber(value.baselineFaceRatio, 'attendance_biometric_baseline_ratio', { min: 0.05, max: 0.95 }),
    actionFaceRatio: finiteNumber(value.actionFaceRatio, 'attendance_biometric_action_ratio', { min: 0.05, max: 0.95 }),
    finalFaceRatio: finiteNumber(value.finalFaceRatio, 'attendance_biometric_final_ratio', { min: 0.05, max: 0.95 }),
    actionRealScoreMin: Math.min(...actionRealScores),
    actionLiveScoreMin: Math.min(...actionLiveScores),
    actionMinimumSimilarity,
    actionDescriptors
  };

  if (Math.abs(evidence.baselineYaw) >= 0.25 || Math.abs(evidence.finalYaw) >= 0.25) {
    throw new Error('attendance_biometric_challenge_evidence_invalid');
  }
  if (expectedAction === 'TURN_SIDE') {
    if (Math.abs(evidence.actionYaw) < 0.20 || Math.abs(evidence.actionYaw - evidence.baselineYaw) < 0.16) {
      throw new Error('attendance_biometric_challenge_evidence_invalid');
    }
  } else if (expectedAction === 'MOVE_CLOSER') {
    if (evidence.actionFaceRatio - evidence.baselineFaceRatio < 0.05) {
      throw new Error('attendance_biometric_challenge_evidence_invalid');
    }
  }
  if (Math.abs(evidence.finalFaceRatio - evidence.baselineFaceRatio) > 0.22) {
    throw new Error('attendance_biometric_challenge_evidence_invalid');
  }
  return evidence;
}

function addFlag(flags, flag, points, state) {
  if (!flags.includes(flag)) flags.push(flag);
  state.score += points;
}

async function captureWasReplayed(prisma, captureHash, descriptorHashValue, idempotencyKey) {
  if (!captureHash && !descriptorHashValue) return false;
  const common = {
    entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
    entityId: { not: idempotencyKey },
    action: WORKER_BIOMETRIC_ACTION.ASSESSED
  };
  try {
    if (captureHash) {
      const captureEvent = await prisma.devAuditEvent.findFirst({
        where: { ...common, metadata: { path: ['captureHash'], equals: captureHash } },
        orderBy: { createdAt: 'desc' }
      });
      if (captureEvent) return true;
    }
    if (descriptorHashValue) {
      const descriptorEvent = await prisma.devAuditEvent.findFirst({
        where: { ...common, metadata: { path: ['descriptorHash'], equals: descriptorHashValue } },
        orderBy: { createdAt: 'desc' }
      });
      if (descriptorEvent) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function assessmentTime(event) {
  const value = event?.metadata?.assessedAt || event?.createdAt;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function assertWorkerBiometricAttemptAllowed(prisma, input = {}, options = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const assignmentId = normalizeString(input.assignmentId, 120);
  const markType = normalizeString(input.markType, 40)?.toUpperCase() || null;
  const now = options.now || new Date();
  if (!workerId || !assignmentId || !validDate(now) || (markType && !BIOMETRIC_MARK_TYPES.has(markType))) {
    throw new Error('attendance_biometric_rate_limit_input_invalid');
  }
  const since = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
      entityLabel: assignmentId,
      action: WORKER_BIOMETRIC_ACTION.ASSESSED,
      createdAt: { gte: since }
    },
    orderBy: { createdAt: 'desc' },
    take: 25
  });
  const relevant = events
    .filter((event) => (
      String(event?.metadata?.workerId || '') === workerId
      && (!markType || String(event?.metadata?.markType || '') === markType)
    ))
    .sort((left, right) => (assessmentTime(right)?.getTime() || 0) - (assessmentTime(left)?.getTime() || 0));

  let consecutiveFailures = 0;
  let latestFailureAt = null;
  for (const event of relevant) {
    if (event?.metadata?.verified === true && event?.metadata?.decision === 'VERIFIED') break;
    consecutiveFailures += 1;
    if (!latestFailureAt) latestFailureAt = assessmentTime(event);
  }
  if (consecutiveFailures < RATE_LIMIT_INITIAL_FAILURES || !latestFailureAt) {
    return { allowed: true, consecutiveFailures, retryAfterMs: 0 };
  }

  const exponent = Math.min(4, consecutiveFailures - RATE_LIMIT_INITIAL_FAILURES);
  const delayMs = Math.min(RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_BASE_DELAY_MS * (2 ** exponent));
  const retryAfterMs = latestFailureAt.getTime() + delayMs - now.getTime();
  if (retryAfterMs <= 0) return { allowed: true, consecutiveFailures, retryAfterMs: 0 };

  const error = new Error('attendance_biometric_rate_limited');
  error.retryAfterMs = retryAfterMs;
  error.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  error.consecutiveFailures = consecutiveFailures;
  throw error;
}

export function isWorkerBiometricVerificationUsable(metadata, expected = {}, now = new Date()) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !validDate(now)) return false;
  const validUntil = new Date(metadata.validUntil);
  return metadata.decision === 'VERIFIED'
    && metadata.verified === true
    && Number(metadata.evidenceVersion) === WORKER_BIOMETRIC_EVIDENCE_VERSION
    && metadata.modelVersion === WORKER_BIOMETRIC_MODEL_VERSION
    && !metadata.consumedAt
    && !Number.isNaN(validUntil.getTime())
    && validUntil.getTime() >= now.getTime()
    && String(metadata.workerId || '') === String(expected.workerId)
    && String(metadata.assignmentId || '') === String(expected.assignmentId)
    && String(metadata.markType || '') === String(expected.markType)
    && (!expected.idempotencyKey || String(metadata.idempotencyKey || '') === String(expected.idempotencyKey));
}

export async function assessWorkerBiometric(prisma, input = {}, options = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const assignmentId = normalizeString(input.assignmentId, 120);
  const idempotencyKey = normalizeString(input.idempotencyKey, 120);
  const markType = normalizeString(input.markType, 40)?.toUpperCase();
  const now = options.now || new Date();
  if (!workerId || !assignmentId || !idempotencyKey || !BIOMETRIC_MARK_TYPES.has(markType) || !validDate(now)) {
    throw new Error('attendance_biometric_assessment_input_invalid');
  }

  const existing = await prisma.devAuditEvent.findFirst({
    where: { entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE, entityId: idempotencyKey, action: WORKER_BIOMETRIC_ACTION.ASSESSED },
    orderBy: { createdAt: 'desc' }
  });
  if (existing?.metadata) return existing.metadata;

  await assertWorkerBiometricAttemptAllowed(prisma, { workerId, assignmentId, markType }, { now });

  const flags = [];
  const state = { score: 0 };
  const enrollment = await getWorkerBiometricEnrollment(prisma, workerId, options);
  let descriptor = null;
  let challenge = null;
  let challengeEvidence = null;
  let publicChallengeEvidence = null;
  let similarity = null;
  let hash = null;
  let captureHash = null;
  let realScore = Number(input.realScore);
  let liveScore = Number(input.liveScore);
  let minimumSampleSimilarityValue = null;
  let actionIdentitySimilarity = null;
  let sampleCount = 1;
  const strictEvidence = Number(input.evidenceVersion) === WORKER_BIOMETRIC_EVIDENCE_VERSION;

  if (!enrollment.enrolled) {
    addFlag(flags, 'BIOMETRIC_NOT_ENROLLED', 35, state);
  } else if (!enrollment.descriptor) {
    addFlag(flags, 'BIOMETRIC_TEMPLATE_UNAVAILABLE', 60, state);
  } else if (strictEvidence && enrollment.evidenceVersion !== WORKER_BIOMETRIC_EVIDENCE_VERSION) {
    addFlag(flags, 'BIOMETRIC_ENROLLMENT_UPGRADE_REQUIRED', 70, state);
  }

  try {
    challenge = verifyChallenge(input.challengeToken, { workerId, assignmentId, idempotencyKey, markType }, { ...options, now });
  } catch (error) {
    addFlag(flags, error?.message === 'attendance_biometric_challenge_expired' ? 'BIOMETRIC_CHALLENGE_EXPIRED' : 'BIOMETRIC_CHALLENGE_INVALID', 55, state);
  }

  if (challenge && (input.challengeCompleted !== true || input.challengeAction !== challenge.action)) {
    addFlag(flags, 'BIOMETRIC_CHALLENGE_NOT_COMPLETED', 55, state);
  }

  if (strictEvidence) {
    try {
      if (normalizeString(input.modelVersion, 100) !== WORKER_BIOMETRIC_MODEL_VERSION) {
        throw new Error('attendance_biometric_model_version_invalid');
      }
      const verificationSampleCount = input.challengeEvidence?.kind === PASSIVE_CHALLENGE_KIND
        ? PASSIVE_VERIFICATION_SAMPLE_COUNT
        : VERIFICATION_SAMPLE_COUNT;
      const samples = validateStrictSamples(input, verificationSampleCount, 'verification');
      descriptor = samples.descriptor;
      hash = descriptorHash(descriptor);
      realScore = samples.realScore;
      liveScore = samples.liveScore;
      minimumSampleSimilarityValue = samples.minimumSimilarity;
      sampleCount = verificationSampleCount;
      if (!challenge) throw new Error('attendance_biometric_challenge_invalid');
      challengeEvidence = normalizeChallengeEvidence(input.challengeEvidence, challenge.action);
      if (challengeEvidence.kind === PASSIVE_CHALLENGE_KIND) {
        captureHash = descriptorSequenceHash(samples.descriptors);
        publicChallengeEvidence = challengeEvidence;
      } else {
        const actionDescriptor = averageDescriptors(challengeEvidence.actionDescriptors);
        actionIdentitySimilarity = humanFaceSimilarity(descriptor, actionDescriptor);
        if (actionIdentitySimilarity < ACTION_IDENTITY_THRESHOLD) {
          throw new Error('attendance_biometric_challenge_identity_inconsistent');
        }
        captureHash = descriptorSequenceHash([
          ...samples.descriptors,
          ...challengeEvidence.actionDescriptors
        ]);
        publicChallengeEvidence = {
          ...challengeEvidence,
          actionDescriptors: undefined,
          actionCaptureHash: descriptorSequenceHash(challengeEvidence.actionDescriptors),
          actionIdentitySimilarity
        };
        delete publicChallengeEvidence.actionDescriptors;
      }
    } catch (error) {
      const code = error?.message;
      if (code === 'attendance_biometric_antispoof_low') addFlag(flags, 'BIOMETRIC_ANTISPOOF_LOW', 50, state);
      else if (code === 'attendance_biometric_liveness_low') addFlag(flags, 'BIOMETRIC_LIVENESS_LOW', 45, state);
      else if (code === 'attendance_biometric_samples_inconsistent') addFlag(flags, 'BIOMETRIC_SAMPLES_INCONSISTENT', 65, state);
      else if (code?.includes('challenge')) addFlag(flags, 'BIOMETRIC_CHALLENGE_EVIDENCE_INVALID', 65, state);
      else addFlag(flags, 'BIOMETRIC_EVIDENCE_INVALID', 65, state);
    }
  } else {
    try {
      descriptor = normalizeWorkerBiometricDescriptor(input.descriptor);
      hash = descriptorHash(descriptor);
    } catch {
      addFlag(flags, 'BIOMETRIC_DESCRIPTOR_INVALID', 60, state);
    }
    if (!Number.isFinite(realScore) || realScore < REAL_THRESHOLD) addFlag(flags, 'BIOMETRIC_ANTISPOOF_LOW', 50, state);
    if (!Number.isFinite(liveScore) || liveScore < LIVE_THRESHOLD) addFlag(flags, 'BIOMETRIC_LIVENESS_LOW', 45, state);
  }

  if (descriptor && enrollment.descriptor) {
    similarity = humanFaceSimilarity(enrollment.descriptor, descriptor);
    if (similarity < MATCH_THRESHOLD) addFlag(flags, 'BIOMETRIC_FACE_MISMATCH', 70, state);
    if (await captureWasReplayed(prisma, captureHash, hash, idempotencyKey)) {
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
    matchThreshold: MATCH_THRESHOLD,
    minimumSampleSimilarity: minimumSampleSimilarityValue,
    sampleConsistencyThreshold: SAMPLE_CONSISTENCY_THRESHOLD,
    actionIdentitySimilarity,
    actionIdentityThreshold: ACTION_IDENTITY_THRESHOLD,
    sampleCount,
    realScore: Number.isFinite(realScore) ? realScore : null,
    liveScore: Number.isFinite(liveScore) ? liveScore : null,
    challengeAction: challenge?.action || normalizeString(input.challengeAction, 40),
    challengeCompleted: input.challengeCompleted === true,
    challengeEvidence: publicChallengeEvidence,
    descriptorHash: hash,
    captureHash,
    evidenceVersion: strictEvidence ? WORKER_BIOMETRIC_EVIDENCE_VERSION : 1,
    modelVersion: normalizeString(input.modelVersion, 100) || WORKER_BIOMETRIC_MODEL_VERSION,
    idempotencyKey,
    assessedAt: now.toISOString(),
    validUntil: decision === 'VERIFIED' ? new Date(now.getTime() + VERIFICATION_TTL_MS).toISOString() : null,
    consumedAt: null
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