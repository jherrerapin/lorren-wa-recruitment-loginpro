import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import {
  ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
  WORKER_BIOMETRIC_ACTION,
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  WORKER_BIOMETRIC_MODEL_VERSION,
  assertWorkerBiometricAttemptAllowed,
  normalizeWorkerBiometricDescriptor
} from './workerBiometricService.js';

const FACE_PRESENCE_CHALLENGE_TTL_MS = 3 * 60 * 1000;
const FACE_PRESENCE_VERIFICATION_TTL_MS = 90 * 1000;
const FACE_PRESENCE_REAL_THRESHOLD = 0.55;
const FACE_PRESENCE_LIVE_THRESHOLD = 0.55;
const FACE_PRESENCE_MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
const FACE_PRESENCE_ACTIONS = Object.freeze(['TURN_SIDE', 'MOVE_CLOSER']);

function normalizeString(value, maxLength = 500) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function presenceSecret(env = process.env) {
  const value = normalizeString(env.ATTENDANCE_BIOMETRIC_SECRET || env.ATTENDANCE_INSTALLATION_PEPPER, 4096);
  if (!value || value.length < 32) throw new Error('attendance_biometric_secret_required');
  return value;
}

function challengeKey(env) {
  return createHmac('sha256', presenceSecret(env)).update('lorren:face-presence-challenge:v1').digest();
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function challengeSignature(payload, env) {
  return createHmac('sha256', challengeKey(env)).update(payload).digest('base64url');
}

function normalizeMarkType(value) {
  const markType = normalizeString(value, 40)?.toUpperCase();
  return markType && FACE_PRESENCE_MARK_TYPES.has(markType) ? markType : null;
}

function normalizeScoreList(value, expectedLength, label) {
  if (!Array.isArray(value) || value.length !== expectedLength) throw new Error(`${label}_invalid`);
  return value.map((entry) => {
    const number = Number(entry);
    if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${label}_invalid`);
    return number;
  });
}

function normalizedPresenceSamples(input = {}) {
  const samples = Array.isArray(input.sampleDescriptors) ? input.sampleDescriptors : [];
  if (samples.length < 1 || samples.length > 4) throw new Error('attendance_face_presence_samples_invalid');
  const descriptors = samples.map((sample) => normalizeWorkerBiometricDescriptor(sample));
  const descriptorLength = descriptors[0]?.length || 0;
  if (!descriptorLength || descriptors.some((descriptor) => descriptor.length !== descriptorLength)) {
    throw new Error('attendance_face_presence_samples_invalid');
  }
  const realScores = normalizeScoreList(input.sampleRealScores, descriptors.length, 'attendance_face_presence_real_scores');
  const liveScores = normalizeScoreList(input.sampleLiveScores, descriptors.length, 'attendance_face_presence_live_scores');
  return { descriptors, realScores, liveScores };
}

function captureHash(descriptors) {
  return createHash('sha256').update(JSON.stringify(descriptors)).digest('hex');
}

function descriptorHash(descriptor) {
  return createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
}

async function captureWasReplayed(prisma, captureHashValue, descriptorHashValue, idempotencyKey) {
  if (!captureHashValue && !descriptorHashValue) return false;
  const common = {
    entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
    entityId: { not: idempotencyKey },
    action: WORKER_BIOMETRIC_ACTION.ASSESSED
  };
  try {
    if (captureHashValue) {
      const event = await prisma.devAuditEvent.findFirst({
        where: { ...common, metadata: { path: ['captureHash'], equals: captureHashValue } },
        orderBy: { createdAt: 'desc' }
      });
      if (event) return true;
    }
    if (descriptorHashValue) {
      const event = await prisma.devAuditEvent.findFirst({
        where: { ...common, metadata: { path: ['descriptorHash'], equals: descriptorHashValue } },
        orderBy: { createdAt: 'desc' }
      });
      if (event) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function verifyChallenge(token, expected = {}, options = {}) {
  const normalized = normalizeString(token, 8192);
  if (!normalized || !normalized.includes('.')) throw new Error('attendance_biometric_challenge_invalid');
  const [payload, signature] = normalized.split('.');
  const expectedSignature = challengeSignature(payload, options.env || process.env);
  const left = Buffer.from(signature || '', 'base64url');
  const right = Buffer.from(expectedSignature, 'base64url');
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('attendance_biometric_challenge_invalid');

  let value;
  try {
    value = JSON.parse(decode(payload));
  } catch {
    throw new Error('attendance_biometric_challenge_invalid');
  }

  const now = options.now || new Date();
  if (!validDate(now)) throw new Error('attendance_biometric_challenge_invalid');
  const expiresAt = new Date(value?.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < now.getTime()) {
    throw new Error('attendance_biometric_challenge_expired');
  }
  for (const key of ['workerId', 'assignmentId', 'idempotencyKey', 'markType']) {
    if (String(value?.[key] || '') !== String(expected?.[key] || '')) {
      throw new Error('attendance_biometric_challenge_mismatch');
    }
  }
  return value;
}

function validatePresenceChallengeEvidence(value, challenge) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('attendance_biometric_challenge_evidence_invalid');
  }
  if (String(value.action || '') !== String(challenge.action || '')) {
    throw new Error('attendance_biometric_challenge_evidence_invalid');
  }
  const kind = normalizeString(value.kind, 80);
  if (!['MODEL_PASSIVE_LIVENESS_V2', 'MODEL_AND_ACTIVE_CHALLENGE_V2'].includes(kind)) {
    throw new Error('attendance_biometric_challenge_evidence_invalid');
  }
  return {
    kind,
    action: challenge.action,
    frames: Number.isFinite(Number(value.frames)) ? Number(value.frames) : null,
    captureDurationMs: Number.isFinite(Number(value.captureDurationMs)) ? Number(value.captureDurationMs) : null
  };
}

function presenceAssessmentBase({ samples, descriptor, challenge, challengeEvidence, idempotencyKey, now }) {
  return {
    facePresent: true,
    similarity: null,
    baseSimilarity: null,
    enrollmentReferenceSimilarity: null,
    enrollmentReferenceCount: 0,
    sessionSimilarity: null,
    referenceSource: 'FACE_PRESENCE',
    identityConfidence: null,
    identityMatchEnforced: false,
    matchThreshold: null,
    attendanceIdentityThreshold: null,
    sessionIdentityThreshold: null,
    minimumSampleSimilarity: null,
    sampleConsistencyThreshold: null,
    actionIdentitySimilarity: null,
    actionIdentityThreshold: null,
    sampleCount: samples.descriptors.length,
    realScore: Math.min(...samples.realScores),
    liveScore: Math.min(...samples.liveScores),
    challengeAction: challenge.action,
    challengeCompleted: true,
    challengeEvidence,
    descriptorHash: descriptorHash(descriptor),
    captureHash: captureHash(samples.descriptors),
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    idempotencyKey,
    assessedAt: now.toISOString(),
    consumedAt: null
  };
}

async function persistAssessment(prisma, input, assessment, now) {
  await prisma.devAuditEvent.create({
    data: {
      entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
      entityId: input.idempotencyKey,
      entityLabel: input.assignmentId,
      action: WORKER_BIOMETRIC_ACTION.ASSESSED,
      actorSource: 'worker-portal',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      metadata: {
        ...assessment,
        workerId: input.workerId,
        assignmentId: input.assignmentId,
        markType: input.markType
      },
      createdAt: now
    }
  });
}

export function workerFacePresenceStatus() {
  return {
    enrolled: true,
    descriptor: [1],
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    presenceOnly: true
  };
}

export async function assertWorkerFacePresenceAttemptAllowed(prisma, input = {}, options = {}) {
  return assertWorkerBiometricAttemptAllowed(prisma, input, options);
}

export function issueWorkerFacePresenceChallenge(input = {}, options = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const assignmentId = normalizeString(input.assignmentId, 120);
  const idempotencyKey = normalizeString(input.idempotencyKey, 120);
  const markType = normalizeMarkType(input.markType);
  const now = options.now || new Date();
  if (!workerId || !assignmentId || !idempotencyKey || !markType || !validDate(now)) {
    throw new Error('attendance_biometric_challenge_input_invalid');
  }

  const randomIndex = Number.isInteger(options.randomIndex)
    ? options.randomIndex
    : randomBytes(1)[0] % FACE_PRESENCE_ACTIONS.length;
  const action = FACE_PRESENCE_ACTIONS[Math.abs(randomIndex) % FACE_PRESENCE_ACTIONS.length];
  const value = {
    v: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    workerId,
    assignmentId,
    idempotencyKey,
    markType,
    action,
    nonce: randomBytes(18).toString('base64url'),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + FACE_PRESENCE_CHALLENGE_TTL_MS).toISOString()
  };
  const payload = encode(JSON.stringify(value));
  return {
    token: `${payload}.${challengeSignature(payload, options.env || process.env)}`,
    action,
    expiresAt: value.expiresAt
  };
}

export async function assessWorkerFacePresence(prisma, input = {}, options = {}) {
  const workerId = normalizeString(input.workerId, 120);
  const assignmentId = normalizeString(input.assignmentId, 120);
  const idempotencyKey = normalizeString(input.idempotencyKey, 120);
  const markType = normalizeMarkType(input.markType);
  const now = options.now || new Date();
  if (!workerId || !assignmentId || !idempotencyKey || !markType || !validDate(now)) {
    throw new Error('attendance_biometric_assessment_input_invalid');
  }
  if (Number(input.evidenceVersion) !== WORKER_BIOMETRIC_EVIDENCE_VERSION) {
    throw new Error('attendance_biometric_evidence_version_invalid');
  }
  if (normalizeString(input.modelVersion, 100) !== WORKER_BIOMETRIC_MODEL_VERSION) {
    throw new Error('attendance_biometric_model_version_invalid');
  }

  const existing = await prisma.devAuditEvent.findFirst({
    where: {
      entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
      entityId: idempotencyKey,
      action: WORKER_BIOMETRIC_ACTION.ASSESSED
    },
    orderBy: { createdAt: 'desc' }
  });
  if (existing?.metadata) return existing.metadata;

  const challenge = verifyChallenge(input.challengeToken, {
    workerId,
    assignmentId,
    idempotencyKey,
    markType
  }, { ...options, now });
  if (input.challengeCompleted !== true || String(input.challengeAction || '') !== challenge.action) {
    throw new Error('attendance_biometric_challenge_not_completed');
  }
  const challengeEvidence = validatePresenceChallengeEvidence(input.challengeEvidence, challenge);
  const samples = normalizedPresenceSamples(input);
  const descriptor = normalizeWorkerBiometricDescriptor(input.descriptor || samples.descriptors[0]);
  if (descriptor.length !== samples.descriptors[0].length) {
    throw new Error('attendance_face_presence_samples_invalid');
  }

  const base = presenceAssessmentBase({ samples, descriptor, challenge, challengeEvidence, idempotencyKey, now });
  const riskFlags = [];
  if (base.realScore < FACE_PRESENCE_REAL_THRESHOLD) riskFlags.push('BIOMETRIC_ANTISPOOF_LOW');
  if (base.liveScore < FACE_PRESENCE_LIVE_THRESHOLD) riskFlags.push('BIOMETRIC_LIVENESS_LOW');
  if (await captureWasReplayed(prisma, base.captureHash, base.descriptorHash, idempotencyKey)) {
    riskFlags.push('BIOMETRIC_DESCRIPTOR_REPLAY');
  }

  const verified = riskFlags.length === 0;
  const assessment = {
    ...base,
    decision: verified ? 'VERIFIED' : 'REJECTED',
    verified,
    riskScore: verified ? 0 : 80,
    riskFlags,
    validUntil: verified ? new Date(now.getTime() + FACE_PRESENCE_VERIFICATION_TTL_MS).toISOString() : null
  };

  await persistAssessment(prisma, { ...input, workerId, assignmentId, idempotencyKey, markType }, assessment, now);
  return assessment;
}
