const VALID_CONSENT_STATUSES = new Set(['ACCEPTED', 'REVOKED']);
const ALLOWED_CANDIDATE_PATCH_FIELDS = new Set([
  'botResumeMode',
  'currentStep',
  'lastInboundAt',
  'status',
  'vacancyId'
]);

function requireNonEmptyString(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label}_required`);
  return normalized;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('consent_timestamp_invalid');
  return date;
}

function validateStatus(status) {
  const normalized = requireNonEmptyString(status, 'consent_status').toUpperCase();
  if (!VALID_CONSENT_STATUSES.has(normalized)) {
    throw new Error(`consent_status_unsupported:${normalized}`);
  }
  return normalized;
}

function sanitizeCandidatePatch(candidatePatch = {}) {
  if (!candidatePatch || typeof candidatePatch !== 'object' || Array.isArray(candidatePatch)) {
    throw new Error('candidate_patch_invalid');
  }

  const sanitized = {};
  for (const [field, value] of Object.entries(candidatePatch)) {
    if (!ALLOWED_CANDIDATE_PATCH_FIELDS.has(field)) {
      throw new Error(`candidate_patch_field_not_allowed:${field}`);
    }
    sanitized[field] = value;
  }
  return sanitized;
}

export function buildConsentStateMutation({
  status,
  version,
  text,
  source,
  actorUsername = null,
  candidatePatch = {},
  now = new Date()
} = {}) {
  const normalizedStatus = validateStatus(status);
  const recordedAt = normalizeTimestamp(now);
  const accepted = normalizedStatus === 'ACCEPTED';
  const patch = sanitizeCandidatePatch(candidatePatch);
  const normalizedVersion = requireNonEmptyString(version, 'consent_version');
  const normalizedText = requireNonEmptyString(text, 'consent_text');
  const normalizedSource = requireNonEmptyString(source, 'consent_source');
  const normalizedActor = normalizeNullableString(actorUsername);

  return {
    recordedAt,
    status: normalizedStatus,
    candidateData: {
      ...patch,
      dataConsentStatus: normalizedStatus,
      dataConsentVersion: normalizedVersion,
      dataConsentText: normalizedText,
      dataConsentSource: normalizedSource,
      dataConsentAcceptedAt: accepted ? recordedAt : null,
      dataConsentRevokedAt: accepted ? null : recordedAt,
      dataConsentRecordedBy: normalizedActor
    },
    eventData: {
      status: normalizedStatus,
      version: normalizedVersion,
      text: normalizedText,
      source: normalizedSource,
      actorUsername: normalizedActor
    }
  };
}

export async function recordCandidateDataConsent(prisma, {
  candidateId,
  status,
  version,
  text,
  source,
  actorUsername = null,
  ipAddress = null,
  userAgent = null,
  note = null,
  candidatePatch = {},
  now = new Date()
} = {}) {
  if (!prisma?.candidate?.update || !prisma?.candidateDataConsentEvent?.create || !prisma?.$transaction) {
    throw new Error('consent_prisma_contract_invalid');
  }

  const normalizedCandidateId = requireNonEmptyString(candidateId, 'candidate_id');
  const mutation = buildConsentStateMutation({
    status,
    version,
    text,
    source,
    actorUsername,
    candidatePatch,
    now
  });

  const [candidate, event] = await prisma.$transaction([
    prisma.candidate.update({
      where: { id: normalizedCandidateId },
      data: mutation.candidateData
    }),
    prisma.candidateDataConsentEvent.create({
      data: {
        candidateId: normalizedCandidateId,
        ...mutation.eventData,
        ipAddress: normalizeNullableString(ipAddress),
        userAgent: normalizeNullableString(userAgent),
        note: normalizeNullableString(note)
      }
    })
  ]);

  return {
    candidate,
    event,
    recordedAt: mutation.recordedAt
  };
}
