import { ConversationStep } from '@prisma/client';
import { ConversationDecisionSchema } from '../contracts/ConversationDecisionSchema.js';
import {
  CONSENT_REQUEST_TEXT,
  CURRENT_CONSENT_VERSION,
  DEFAULT_CONSENT_SOURCE
} from '../contracts/consentDefinition.js';
import { buildSlotSuggestionReply } from '../engine/presentation/schedulingFormatter.js';
import { recordCandidateDataConsent } from '../../services/consentStateService.js';
import {
  cancelActiveInterviewBookings,
  createScheduledInterviewBooking
} from '../../services/interviewBookingStateService.js';
import { listOfferableSlots } from '../../services/interviewScheduler.js';

const CONSENT_FIELD = 'dataConsentStatus';
const DEFAULT_SCHEDULING_TIMEZONE = 'America/Bogota';
const DEFAULT_SLOT_SUGGESTION_LIMIT = 3;
const BOOKING_CONFIRMED_REPLY =
  '¡Tu entrevista ha sido agendada con éxito! En breve recibirás los detalles.';

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

function optionalDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function normalizeSuggestionLimit(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return DEFAULT_SLOT_SUGGESTION_LIMIT;
  return Math.min(numeric, 10);
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

  const version = requireNonEmptyString(
    consentContext.version || CURRENT_CONSENT_VERSION,
    'consent_version'
  );
  const text = requireNonEmptyString(
    consentContext.text || CONSENT_REQUEST_TEXT,
    'consent_text'
  );
  const source = requireNonEmptyString(
    consentContext.source || DEFAULT_CONSENT_SOURCE,
    'consent_source'
  );

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

function projectSlotSuggestion(entry, timezone) {
  return {
    slotId: entry?.slot?.id ? String(entry.slot.id) : null,
    startsAt: entry?.date instanceof Date
      ? entry.date.toISOString()
      : new Date(entry?.date).toISOString(),
    timezone
  };
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
    if (!vacancyId) throw new Error('conversation_scheduling_vacancy_required');

    const timezone = String(
      schedulingContext.timezone || DEFAULT_SCHEDULING_TIMEZONE
    ).trim() || DEFAULT_SCHEDULING_TIMEZONE;
    const now = optionalDate(schedulingContext.now, 'conversation_scheduling_now') || new Date();
    const lastInboundAt = optionalDate(
      schedulingContext.lastInboundAt ?? input?.candidate?.facts?.lastInboundAt,
      'conversation_scheduling_last_inbound_at'
    );
    const limit = normalizeSuggestionLimit(schedulingContext.maxSuggestions);

    // Reuse the existing scheduling authority. The shell performs the query;
    // presentation remains a pure transformation in schedulingFormatter.js.
    const offerableSlots = await listOfferableSlots(
      tx,
      vacancyId,
      lastInboundAt,
      now
    );
    const suggestions = offerableSlots
      .slice(0, limit)
      .map((entry) => projectSlotSuggestion(entry, timezone));

    const replyText = buildSlotSuggestionReply(suggestions, timezone);

    // AWAITING_SLOT_SELECTION is not a persisted ConversationStep today.
    // SCHEDULING is its canonical persisted equivalent until/unless Prisma adds
    // a dedicated enum value in a separately reviewed migration.
    await tx.candidate.update({
      where: { id: candidateId },
      data: {
        currentStep: ConversationStep.SCHEDULING
      }
    });

    return {
      action: 'suggest_slots',
      persisted: true,
      awaitingSlotSelection: true,
      suggestions,
      replyText
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

    const explicitSlotId = scheduling.slot?.slotId
      ?? schedulingContext.slotId
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

    await tx.candidate.update({
      where: { id: candidateId },
      data: {
        currentStep: ConversationStep.SCHEDULED
      }
    });

    return {
      action: 'reserve_slot',
      persisted: true,
      booking,
      replyText: BOOKING_CONFIRMED_REPLY
    };
  }

  throw new Error(`conversation_scheduling_action_unsupported:${scheduling.action}`);
}

async function resolveExecutedDecision(normalizedDecision, executionResult) {
  const replyText = executionResult?.scheduling?.replyText;
  if (!replyText) return normalizedDecision;

  // ConversationDecision is readonly after Zod parsing. Build a short-lived
  // resolved copy rather than mutating the validated Functional Core output.
  // Both slot suggestions and successful reservations can supply replyText.
  const candidate = {
    ...normalizedDecision,
    reply: {
      text: replyText
    }
  };

  const validation = await ConversationDecisionSchema.safeParseAsync(candidate);
  if (!validation.success) {
    const error = new Error('conversation_executor_resolved_decision_invalid');
    error.name = 'ConversationDecisionValidationError';
    error.cause = validation.error;
    throw error;
  }

  return validation.data;
}

/**
 * Imperative-shell executor for a validated ConversationDecision.
 *
 * All state effects are committed in one Prisma transaction when the provided
 * client supports transactions. Domain-specific authorities remain canonical:
 * consent is delegated to consentStateService, availability to interviewScheduler
 * and interview bookings to interviewBookingStateService.
 *
 * The returned `decision` is the effective outbound decision. Scheduling
 * execution may supply a resolved reply for slot suggestions or a confirmed
 * reservation; this executor does not create a second delivery authority.
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

  const executionResult = typeof prisma.$transaction === 'function'
    ? await prisma.$transaction(execute)
    : await execute(prisma);

  const resolvedDecision = await resolveExecutedDecision(
    normalizedDecision,
    executionResult
  );

  return {
    ...executionResult,
    decision: resolvedDecision,
    reply: resolvedDecision.reply
  };
}

export default executeConversationDecision;
