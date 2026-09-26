import { ConversationStep } from '@prisma/client';
import { ConversationDecisionSchema } from '../contracts/ConversationDecisionSchema.js';
import { recordCandidateDataConsent } from '../../services/consentStateService.js';
import {
  cancelActiveInterviewBookings,
  createScheduledInterviewBooking
} from '../../services/interviewBookingStateService.js';

const CONSENT_FIELD = 'dataConsentStatus';
const ALLOWED_DIRECT_CANDIDATE_FIELDS = new Set([
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'gender',
  'locality',
  'neighborhood',
  'transportMode',
  'medicalRestrictions',
  'experienceInfo',
  'experienceTime',
  'experienceSummary',
  'vacancyId',
  'status',
  'currentStep',
  'botResumeMode',
  'reminderState',
  'reminderScheduledFor'
]);

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label}_required`);
  return normalized;
}

function candidateIdFromInput(input = {}) {
  return requireNonEmptyString(input?.candidate?.id, 'candidate_id');
}

function vacancyIdFromInput(input = {}) {
  const value = input?.vacancy?.id ?? input?.candidate?.facts?.vacancyId ?? null;
  return value === null || value === undefined || value === '' ? null : String(value);
}

function splitMutationFields(fieldsToPersist = {}) {
  const direct = {};
  let consentStatus = null;

  for (const [field, value] of Object.entries(fieldsToPersist || {})) {
    if (field === CONSENT_FIELD) {
      consentStatus = String(value || '').trim().toUpperCase() || null;
      continue;
    }
    if (!ALLOWED_DIRECT_CANDIDATE_FIELDS.has(field)) {
      throw new Error(`conversation_mutation_field_not_allowed:${field}`);
    }
    direct[field] = value;
  }

  return { direct, consentStatus };
}

async function executeConsentMutation(tx, {
  candidateId,
  status,
  consentContext = {}
}) {
  if (!status) return null;
  if (!['ACCEPTED', 'REVOKED'].includes(status)) {
    throw new Error(`conversation_consent_status_not_allowed:${status}`);
  }

  const version = requireNonEmptyString(consentContext.version, 'consent_version');
  const text = requireNonEmptyString(consentContext.text, 'consent_text');
  const source = requireNonEmptyString(consentContext.source, 'consent_source');

  return recordCandidateDataConsent(tx, {
    candidateId,
    status,
    version,
    text,
    source,
    actorUsername: consentContext.actorUsername ?? 'candidate_whatsapp',
    ipAddress: consentContext.ipAddress ?? null,
    userAgent: consentContext.userAgent ?? null,
    note: consentContext.note ?? null,
    candidatePatch: consentContext.candidatePatch ?? {},
    expected: consentContext.expected ?? null,
    idempotent: consentContext.idempotent ?? true,
    now: consentContext.now ?? new Date()
  });
}

async function executeSchedulingMutation(tx, {
  input,
  scheduling,
  schedulingContext = {}
}) {
  if (!scheduling) return null;

  const candidateId = candidateIdFromInput(input);
  const vacancyId = vacancyIdFromInput(input);

  if (scheduling.action === 'suggest_slots') {
    return {
      action: 'suggest_slots',
      persisted: false
    };
  }

  if (scheduling.action === 'cancel_booking') {
    const result = await cancelActiveInterviewBookings(tx, { candidateId });
    return {
      action: 'cancel_booking',
      persisted: true,
      count: Number(result?.count || 0)
    };
  }

  if (scheduling.action === 'reserve_slot') {
    if (!vacancyId) throw new Error('conversation_scheduling_vacancy_required');
    const startsAt = new Date(scheduling.slot.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      throw new Error('conversation_scheduling_starts_at_invalid');
    }

    const explicitSlotId = schedulingContext.slotId
      ?? schedulingContext.slot?.id
      ?? null;
    const manualScheduling = explicitSlotId === null || explicitSlotId === undefined || explicitSlotId === '';

    const booking = await createScheduledInterviewBooking(tx, {
      candidateId,
      vacancyId,
      slotId: manualScheduling ? null : String(explicitSlotId),
      scheduledAt: startsAt,
      manualScheduling,
      reminderWindowClosed: schedulingContext.reminderWindowClosed ?? false,
      replacementStatus: 'RESCHEDULED'
    });

    return {
      action: 'reserve_slot',
      persisted: true,
      booking
    };
  }

  throw new Error(`conversation_scheduling_action_unsupported:${scheduling.action}`);
}

/**
 * Imperative-shell executor for a validated ConversationDecision.
 *
 * All state effects are committed in one Prisma transaction when the provided
 * client supports transactions. Domain-specific authorities remain canonical:
 * consent is delegated to consentStateService and interview bookings to
 * interviewBookingStateService.
 */
export async function executeConversationDecision({
  prisma,
  input,
  decision,
  consentContext = {},
  schedulingContext = {}
} = {}) {
  if (!prisma?.candidate) throw new Error('conversation_executor_prisma_required');

  const validation = await ConversationDecisionSchema.safeParseAsync(decision);
  if (!validation.success) {
    const error = new Error('conversation_executor_decision_invalid');
    error.name = 'ConversationDecisionValidationError';
    error.cause = validation.error;
    throw error;
  }

  const normalizedDecision = validation.data;
  const candidateId = candidateIdFromInput(input);
  const { direct, consentStatus } = splitMutationFields(
    normalizedDecision.mutations.fieldsToPersist
  );

  const execute = async (tx) => {
    const result = {
      candidate: null,
      consent: null,
      scheduling: null
    };

    if (Object.keys(direct).length) {
      result.candidate = await tx.candidate.update({
        where: { id: candidateId },
        data: direct
      });
    }

    if (consentStatus) {
      result.consent = await executeConsentMutation(tx, {
        candidateId,
        status: consentStatus,
        consentContext
      });
      if (result.consent?.conflict) {
        throw new Error('conversation_consent_transition_conflict');
      }
    }

    result.scheduling = await executeSchedulingMutation(tx, {
      input,
      scheduling: normalizedDecision.scheduling,
      schedulingContext
    });

    if (normalizedDecision.transitions.endConversation) {
      result.candidate = await tx.candidate.update({
        where: { id: candidateId },
        data: {
          currentStep: ConversationStep.DONE,
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
    } else if (!result.candidate) {
      result.candidate = await tx.candidate.findUnique({ where: { id: candidateId } });
    }

    return result;
  };

  if (typeof prisma.$transaction === 'function') {
    return prisma.$transaction(execute);
  }
  return execute(prisma);
}

export default executeConversationDecision;
