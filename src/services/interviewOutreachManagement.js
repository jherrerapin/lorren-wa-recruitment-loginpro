export const INTERVIEW_INVITATION_STATUSES = Object.freeze([
  'PENDING',
  'CONFIRMED',
  'DECLINED'
]);

export const INTERVIEW_ATTENDANCE_STATUSES = Object.freeze([
  'PENDING',
  'ATTENDED',
  'NO_SHOW'
]);

const INTERVIEW_INVITATION_STATUS_SET = new Set(INTERVIEW_INVITATION_STATUSES);
const INTERVIEW_ATTENDANCE_STATUS_SET = new Set(INTERVIEW_ATTENDANCE_STATUSES);
const MAX_OBSERVATION_LENGTH = 4000;
const MAX_COMPLEMENTARY_LABEL_LENGTH = 80;
const MAX_COMPLEMENTARY_VALUE_LENGTH = 2000;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}_required`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${label}_required`);
  return normalized;
}

function requireValidDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label}_invalid`);
  return date;
}

function timeValue(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function normalizeActor(actor = {}) {
  const value = requireObject(actor, 'interview_actor');
  const label = requireNonEmptyString(value.label, 'interview_actor_label');
  const userId = value.userId == null ? null : requireNonEmptyString(value.userId, 'interview_actor_user_id');
  return { userId, label };
}

function requireManagementClient(prisma, model, methods) {
  const client = prisma?.[model];
  if (!client || methods.some((method) => typeof client[method] !== 'function')) {
    throw new TypeError(`interview_management_${model}_client_required`);
  }
  return prisma;
}

export function normalizeInterviewInvitationStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!INTERVIEW_INVITATION_STATUS_SET.has(normalized)) {
    throw new TypeError('interview_invitation_status_invalid');
  }
  return normalized;
}

export function normalizeInterviewAttendanceStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!INTERVIEW_ATTENDANCE_STATUS_SET.has(normalized)) {
    throw new TypeError('interview_attendance_status_invalid');
  }
  return normalized;
}

function normalizeEvidenceInvitationStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['CONFIRMADO', 'CONFIRMED'].includes(normalized)) return 'CONFIRMED';
  if (['NO_ASISTE', 'DECLINED'].includes(normalized)) return 'DECLINED';
  return 'PENDING';
}

export function resolveEffectiveInvitationStatus(review = null, evidence = null) {
  const manualStatus = review?.invitationStatusOverride
    ? normalizeInterviewInvitationStatus(review.invitationStatusOverride)
    : null;
  const manualAt = timeValue(review?.invitationUpdatedAt);
  const evidenceStatus = normalizeEvidenceInvitationStatus(evidence?.status);
  const evidenceAt = timeValue(evidence?.respondedAt);

  if (manualStatus && (!evidenceAt || manualAt >= evidenceAt)) {
    return {
      status: manualStatus,
      source: 'MANUAL',
      updatedAt: review?.invitationUpdatedAt || null,
      updatedByLabel: review?.invitationUpdatedByLabel || null
    };
  }

  if (evidenceAt && evidenceStatus !== 'PENDING') {
    return {
      status: evidenceStatus,
      source: 'WHATSAPP',
      updatedAt: evidence?.respondedAt || null,
      updatedByLabel: null
    };
  }

  if (manualStatus) {
    return {
      status: manualStatus,
      source: 'MANUAL',
      updatedAt: review?.invitationUpdatedAt || null,
      updatedByLabel: review?.invitationUpdatedByLabel || null
    };
  }

  return {
    status: 'PENDING',
    source: 'NONE',
    updatedAt: null,
    updatedByLabel: null
  };
}

export function normalizeInterviewRating(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const normalizedText = String(value).trim().replace(',', '.');
  const numeric = Number(normalizedText);
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 5) {
    throw new TypeError('interview_rating_out_of_range');
  }
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

export function deriveInterviewRatingBand(value) {
  const rating = normalizeInterviewRating(value);
  if (rating === null) return null;
  if (rating < 3) {
    return { key: 'DISQUALIFIED', label: 'Descalificado' };
  }
  if (rating < 3.6) {
    return { key: 'RESERVE', label: 'Reserva' };
  }
  return { key: 'OPTIONED', label: 'Opcionado a contratar' };
}

export function normalizeInterviewObservation({ enabled = false, value = '' } = {}) {
  const observationEnabled = enabled === true || String(enabled).toLowerCase() === 'true' || String(enabled) === '1';
  if (!observationEnabled) return { observationEnabled: false, observation: null };
  const observation = String(value || '').trim();
  if (!observation) throw new TypeError('interview_observation_required_when_enabled');
  if (observation.length > MAX_OBSERVATION_LENGTH) {
    throw new TypeError('interview_observation_too_long');
  }
  return { observationEnabled: true, observation };
}

export function normalizeInterviewComplementaryLabel(value) {
  const label = requireNonEmptyString(value, 'interview_complementary_label')
    .replace(/\s+/g, ' ');
  if (label.length > MAX_COMPLEMENTARY_LABEL_LENGTH) {
    throw new TypeError('interview_complementary_label_too_long');
  }
  const normalizedLabel = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return { label, normalizedLabel };
}

export function normalizeInterviewComplementaryValue(value) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > MAX_COMPLEMENTARY_VALUE_LENGTH) {
    throw new TypeError('interview_complementary_value_too_long');
  }
  return normalized || null;
}

export async function setInterviewInvitationStatus(prisma, input = {}) {
  requireManagementClient(prisma, 'interviewCandidateReview', ['upsert']);
  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const vacancyId = requireNonEmptyString(input.vacancyId, 'vacancy_id');
  const status = normalizeInterviewInvitationStatus(input.status);
  const actor = normalizeActor(input.actor);
  const now = requireValidDate(input.now === undefined ? new Date() : input.now, 'interview_invitation_updated_at');
  const actorData = {
    invitationStatusOverride: status,
    invitationUpdatedByUserId: actor.userId,
    invitationUpdatedByLabel: actor.label,
    invitationUpdatedAt: now
  };

  return prisma.interviewCandidateReview.upsert({
    where: { candidateId_vacancyId: { candidateId, vacancyId } },
    update: actorData,
    create: {
      candidateId,
      vacancyId,
      ...actorData
    }
  });
}

export async function setInterviewAttendanceStatus(prisma, input = {}) {
  requireManagementClient(prisma, 'interviewCandidateReview', ['upsert']);
  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const vacancyId = requireNonEmptyString(input.vacancyId, 'vacancy_id');
  const status = normalizeInterviewAttendanceStatus(input.status);
  const actor = normalizeActor(input.actor);
  const now = requireValidDate(input.now === undefined ? new Date() : input.now, 'interview_attendance_updated_at');
  const actorData = {
    attendanceStatus: status,
    attendanceUpdatedByUserId: actor.userId,
    attendanceUpdatedByLabel: actor.label,
    attendanceUpdatedAt: now
  };

  return prisma.interviewCandidateReview.upsert({
    where: { candidateId_vacancyId: { candidateId, vacancyId } },
    update: actorData,
    create: {
      candidateId,
      vacancyId,
      ...actorData
    }
  });
}

export async function saveInterviewEvaluation(prisma, input = {}) {
  requireManagementClient(prisma, 'interviewCandidateReview', ['upsert']);
  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const vacancyId = requireNonEmptyString(input.vacancyId, 'vacancy_id');
  const rating = normalizeInterviewRating(input.rating);
  const observation = normalizeInterviewObservation({
    enabled: input.observationEnabled,
    value: input.observation
  });
  const actor = normalizeActor(input.actor);
  const now = requireValidDate(input.now === undefined ? new Date() : input.now, 'interview_review_updated_at');
  const reviewData = {
    rating,
    ...observation,
    reviewUpdatedByUserId: actor.userId,
    reviewUpdatedByLabel: actor.label,
    reviewUpdatedAt: now
  };

  const review = await prisma.interviewCandidateReview.upsert({
    where: { candidateId_vacancyId: { candidateId, vacancyId } },
    update: reviewData,
    create: {
      candidateId,
      vacancyId,
      ...reviewData
    }
  });

  return {
    review,
    ratingBand: deriveInterviewRatingBand(rating)
  };
}

export async function createInterviewComplementaryField(prisma, input = {}) {
  requireManagementClient(prisma, 'interviewComplementaryField', ['findUnique', 'count', 'upsert']);
  const { label, normalizedLabel } = normalizeInterviewComplementaryLabel(input.label);
  const actor = normalizeActor(input.actor);
  const uniqueWhere = { normalizedLabel };
  const existing = await prisma.interviewComplementaryField.findUnique({ where: uniqueWhere });
  if (existing) return { field: existing, created: false };

  const sortOrder = await prisma.interviewComplementaryField.count();
  const field = await prisma.interviewComplementaryField.upsert({
    where: uniqueWhere,
    update: {},
    create: {
      label,
      normalizedLabel,
      sortOrder,
      createdByUserId: actor.userId,
      createdByLabel: actor.label
    }
  });
  return { field, created: true };
}

export async function saveInterviewComplementaryValues(prisma, input = {}) {
  requireManagementClient(prisma, 'interviewComplementaryField', ['findMany']);
  requireManagementClient(prisma, 'interviewComplementaryValue', ['upsert']);
  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const actor = normalizeActor(input.actor);
  const rawValues = Array.isArray(input.values) ? input.values : [];
  const unique = new Map();

  for (const raw of rawValues) {
    const fieldId = requireNonEmptyString(raw?.fieldId, 'interview_complementary_field_id');
    unique.set(fieldId, {
      fieldId,
      value: normalizeInterviewComplementaryValue(raw?.value)
    });
  }

  const values = [...unique.values()];
  if (!values.length) return [];

  const fields = await prisma.interviewComplementaryField.findMany({
    where: {
      id: { in: values.map(({ fieldId }) => fieldId) }
    },
    select: { id: true }
  });
  const allowedIds = new Set(fields.map((field) => field.id));
  if (values.some(({ fieldId }) => !allowedIds.has(fieldId))) {
    throw new TypeError('interview_complementary_field_invalid');
  }

  const operations = values.map(({ fieldId, value }) => prisma.interviewComplementaryValue.upsert({
    where: { candidateId_fieldId: { candidateId, fieldId } },
    update: {
      value,
      updatedByUserId: actor.userId,
      updatedByLabel: actor.label
    },
    create: {
      candidateId,
      fieldId,
      value,
      updatedByUserId: actor.userId,
      updatedByLabel: actor.label
    }
  }));

  if (typeof prisma.$transaction === 'function') {
    return prisma.$transaction(operations);
  }
  return Promise.all(operations);
}

export function buildInterviewManagementSnapshot({
  review = null,
  evidence = null,
  fields = [],
  values = []
} = {}) {
  const effectiveInvitation = resolveEffectiveInvitationStatus(review, evidence);
  const rating = review?.rating == null ? null : Number(review.rating);
  const valueByFieldId = new Map((values || []).map((value) => [value.fieldId, value]));

  return {
    invitation: effectiveInvitation,
    attendance: {
      status: review?.attendanceStatus || 'PENDING',
      updatedAt: review?.attendanceUpdatedAt || null,
      updatedByLabel: review?.attendanceUpdatedByLabel || null
    },
    evaluation: {
      rating,
      band: deriveInterviewRatingBand(rating),
      observationEnabled: Boolean(review?.observationEnabled),
      observation: review?.observation || null,
      updatedAt: review?.reviewUpdatedAt || null,
      updatedByLabel: review?.reviewUpdatedByLabel || null
    },
    complementaryFields: [...(fields || [])]
      .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0) || String(left.label).localeCompare(String(right.label)))
      .map((field) => {
        const value = valueByFieldId.get(field.id);
        return {
          id: field.id,
          label: field.label,
          sortOrder: field.sortOrder,
          value: value?.value || '',
          updatedAt: value?.updatedAt || null,
          updatedByLabel: value?.updatedByLabel || null
        };
      })
  };
}
