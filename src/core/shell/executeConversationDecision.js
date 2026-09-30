import { ConversationStep, MessageType } from '@prisma/client';
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
import { deliverAutomaticOutboundText } from '../../services/automaticOutboundDeliveryService.js';
import { sanitizeOutboundReply } from '../../services/outboundReplyPolicy.js';
import { pauseCandidateAutomationForManualReview } from '../../services/candidateStateService.js';
import { notifySupervisorManualReview } from '../../services/adminSupervisor.js';

const CONSENT_FIELD = 'dataConsentStatus';
const DEFAULT_SCHEDULING_TIMEZONE = 'America/Bogota';
const DEFAULT_SLOT_SUGGESTION_LIMIT = 3;
const BOOKING_CONFIRMED_REPLY =
  '¡Tu entrevista ha sido agendada con éxito! En breve recibirás los detalles.';

export class ConversationDecisionExecutionError extends Error {
  constructor(phase, cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Conversation decision ${phase} phase failed: ${message}`, { cause });
    this.name = 'ConversationDecisionExecutionError';
    this.phase = phase;
  }
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function normalizeExecutionArguments(inputOrOptions, decision, dependencies) {
  if (decision !== undefined || inputOrOptions?.turn) {
    return {
      ...asRecord(dependencies),
      input: inputOrOptions,
      decision
    };
  }
  return asRecord(inputOrOptions);
}

async function defaultAutomaticOutboundDelivery(prisma, outbound, adapters) {
  return await deliverAutomaticOutboundText(prisma, outbound, adapters);
}

const ALLOWED_DIRECT_CANDIDATE_FIELDS = new Set([
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'gender',
  'recruitmentCity',
  'recruitmentRole',
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
  const source = asRecord(fieldsToPersist);
  const direct = {};
  let consentStatus = null;
  const hasPauseInstruction = Object.hasOwn(source, 'botPaused');
  const pauseRequested = source.botPaused === true;

  if (hasPauseInstruction && !pauseRequested) {
    throw new Error('conversation_manual_review_pause_must_be_true');
  }
  if (Object.hasOwn(source, 'botPauseReason') && !pauseRequested) {
    throw new Error('conversation_manual_review_pause_instruction_required');
  }

  const manualReviewPause = pauseRequested
    ? {
        reason: requireNonEmptyString(
          source.botPauseReason,
          'conversation_manual_review_pause_reason'
        )
      }
    : null;

  for (const [field, value] of Object.entries(source)) {
    if (field === CONSENT_FIELD) {
      consentStatus = String(value || '').trim().toUpperCase() || null;
      continue;
    }
    if (field === 'botPaused' || field === 'botPauseReason') continue;
    if (
      manualReviewPause
      && (field === 'reminderState' || field === 'reminderScheduledFor')
    ) {
      continue;
    }
    if (!ALLOWED_DIRECT_CANDIDATE_FIELDS.has(field)) {
      throw new Error(`conversation_mutation_field_not_allowed:${field}`);
    }
    direct[field] = value;
  }

  return { direct, consentStatus, manualReviewPause };
}

function manualReviewPauseSnapshot(candidate) {
  if (!candidate) throw new Error('conversation_manual_review_candidate_not_found');
  return {
    botPaused: candidate.botPaused,
    botPausedAt: candidate.botPausedAt,
    botPausedBy: candidate.botPausedBy,
    botPauseReason: candidate.botPauseReason,
    botResumeMode: candidate.botResumeMode,
    reminderScheduledFor: candidate.reminderScheduledFor,
    reminderState: candidate.reminderState
  };
}

function wasManualReviewPauseApplied(result) {
  return result === true || Number(result?.count || 0) === 1;
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
  if (scheduling.action === 'none') {
    return { action: 'none', persisted: false };
  }

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

function buildGenerationArguments(input, decision) {
  const fieldsToPersist = asRecord(decision?.mutations?.fieldsToPersist);
  const publicFieldsToPersist = Object.fromEntries(
    Object.entries(fieldsToPersist).filter(([field]) => field !== 'gender')
  );
  const pendingFields = Array.isArray(input?.pending?.fields) ? input.pending.fields : [];
  const remainingPendingFields = pendingFields.filter((field) => (
    field !== 'gender'
    && !Object.prototype.hasOwnProperty.call(fieldsToPersist, field)
  ));

  return {
    parameters: Object.freeze({
      fieldsToPersist: Object.freeze(publicFieldsToPersist),
      nextStep: decision?.mutations?.nextStep ?? null,
      pendingFields: Object.freeze([...remainingPendingFields]),
      ...asRecord(decision?.reply?.parameters)
    }),
    context: Object.freeze({
      turn: input?.turn,
      candidate: input?.candidate,
      history: input?.history,
      pending: input?.pending
    })
  };
}

async function resolveOutboundText(input, decision, llmService) {
  const reply = decision?.reply;
  if (!reply) return { text: null, status: 'skipped' };
  if (typeof reply.text === 'string' && reply.text.trim()) {
    return { text: reply.text, status: 'provided' };
  }
  if (typeof reply.directive !== 'string' || !reply.directive.trim()) {
    return { text: null, status: 'skipped' };
  }
  if (typeof llmService?.generateReply !== 'function') {
    throw new Error('conversation_executor_llm_service_required');
  }
  const { parameters, context } = buildGenerationArguments(input, decision);
  const text = await llmService.generateReply(reply.directive.trim(), parameters, context);
  return {
    text: requireNonEmptyString(text, 'generated_reply'),
    status: 'generated'
  };
}

async function deliverResolvedReply({
  prisma,
  input,
  decision,
  text,
  whatsappClient,
  deliveryAuthority = deliverAutomaticOutboundText,
  deliveryAdapters = {}
}) {
  if (!text || typeof whatsappClient?.sendMessage !== 'function') return null;

  const candidateId = candidateIdFromInput(input);
  const phone = requireNonEmptyString(input?.candidate?.facts?.phone, 'candidate_phone');
  const turnId = requireNonEmptyString(input?.turn?.id, 'turn_id');
  const interactiveOptions = Array.isArray(decision?.reply?.interactiveOptions)
    ? decision.reply.interactiveOptions
    : [];
  const intent = typeof input?.interpretation?.intent === 'string'
    ? input.interpretation.intent.trim() || null
    : null;
  const schedulingAction = typeof decision?.scheduling?.action === 'string'
    ? decision.scheduling.action.trim() || null
    : null;

  return await deliveryAuthority(prisma, {
    candidateId,
    to: phone,
    body: text,
    messageType: interactiveOptions.length ? MessageType.INTERACTIVE : MessageType.TEXT,
    rawPayload: {
      source: 'FUNCTIONAL_CORE',
      turnId,
      intent,
      schedulingAction,
      ...(decision?.reply?.directive ? { directive: decision.reply.directive } : {}),
      ...(interactiveOptions.length ? { interactiveOptions } : {})
    },
    idempotencyKey: `conversation-turn:${candidateId}:${turnId}`
  }, {
    ...asRecord(deliveryAdapters),
    sendText: (to, body) => whatsappClient.sendMessage(to, body, interactiveOptions)
  });
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
export async function executeConversationDecision(
  inputOrOptions = {},
  decisionArgument,
  dependencyArgument = {}
) {
  const {
    prisma,
    input,
    decision,
    consentContext = {},
    schedulingContext = {},
    llmService = null,
    whatsappClient = null,
    automaticOutboundDelivery = defaultAutomaticOutboundDelivery,
    deliveryAdapters = {},
    manualReviewPauseAuthority = pauseCandidateAutomationForManualReview,
    manualReviewNotifier = notifySupervisorManualReview
  } = normalizeExecutionArguments(inputOrOptions, decisionArgument, dependencyArgument);
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
  const execution = asRecord(input?.execution);
  const dryRun = execution.dryRun === true;
  const mayPersistCandidate = !dryRun && execution.mayPersistCandidate !== false;
  const mayReply = execution.mayReply !== false;
  const maySendOutbound = !dryRun && execution.maySendOutbound !== false;
  const { direct, consentStatus, manualReviewPause } = splitMutationFields(
    normalizedDecision.mutations.fieldsToPersist
  );
  if (normalizedDecision.mutations.nextStep) {
    direct.currentStep = normalizedDecision.mutations.nextStep;
  }
  if (normalizedDecision.mutations.nextStage) {
    direct.status = normalizedDecision.mutations.nextStage;
  }

  if (dryRun) {
    return {
      candidate: null,
      consent: null,
      scheduling: null,
      decision: normalizedDecision,
      reply: normalizedDecision.reply,
      dryRun: true,
      persistence: { status: 'skipped' },
      generation: { status: 'skipped' },
      delivery: { status: 'skipped' }
    };
  }

  const execute = async (tx) => {
    const result = {
      candidate: null,
      consent: null,
      scheduling: null,
      manualReviewPause: null
    };

    if (typeof tx?.message?.createMany === 'function') {
      await tx.message.createMany({
        data: [{
          candidateId,
          waMessageId: requireNonEmptyString(input?.turn?.id, 'turn_id'),
          direction: 'INBOUND',
          messageType: input?.turn?.rawText === '[SYSTEM_EVENT]'
            ? MessageType.UNKNOWN
            : MessageType.TEXT,
          body: input?.turn?.rawText ?? '',
          rawPayload: {
            source: 'FUNCTIONAL_CORE',
            turnId: input?.turn?.id
          },
          createdAt: optionalDate(input?.turn?.receivedAt, 'turn_received_at') || new Date()
        }],
        skipDuplicates: true
      });
    }

    if (mayPersistCandidate && manualReviewPause) {
      if (typeof tx?.candidate?.findUnique !== 'function') {
        throw new Error('conversation_manual_review_candidate_reader_required');
      }
      const candidateSnapshot = await tx.candidate.findUnique({
        where: { id: candidateId }
      });
      result.manualReviewPause = await manualReviewPauseAuthority(tx, {
        candidateId,
        expected: manualReviewPauseSnapshot(candidateSnapshot),
        reason: manualReviewPause.reason,
        pausedAt: new Date()
      });
      if (wasManualReviewPauseApplied(result.manualReviewPause)) {
        result.candidate = result.manualReviewPause?.candidate || candidateSnapshot;
      }
    }

    const pauseAllowsCandidateUpdates = !manualReviewPause
      || wasManualReviewPauseApplied(result.manualReviewPause);

    if (mayPersistCandidate && pauseAllowsCandidateUpdates && Object.keys(direct).length) {
      result.candidate = await tx.candidate.update({
        where: { id: candidateId },
        data: direct
      });
    }

    if (mayPersistCandidate && consentStatus) {
      result.consent = await executeConsentMutation(tx, {
        candidateId,
        status: consentStatus,
        consentContext
      });
      if (result.consent?.conflict) {
        throw new Error('conversation_consent_transition_conflict');
      }
    }

    if (mayPersistCandidate) {
      result.scheduling = await executeSchedulingMutation(tx, {
        input,
        scheduling: normalizedDecision.scheduling,
        schedulingContext
      });
    }

    if (mayPersistCandidate && normalizedDecision.transitions.endConversation) {
      result.candidate = await tx.candidate.update({
        where: { id: candidateId },
        data: {
          currentStep: ConversationStep.DONE,
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
    }

    return result;
  };

  let executionResult;
  try {
    executionResult = typeof prisma.$transaction === 'function'
      ? await prisma.$transaction(execute)
      : await execute(prisma);
  } catch (error) {
    throw new ConversationDecisionExecutionError('persistence', error);
  }

  const resolvedDecision = await resolveExecutedDecision(
    normalizedDecision,
    executionResult
  );

  const result = {
    ...executionResult,
    decision: resolvedDecision,
    reply: resolvedDecision.reply,
    dryRun: false,
    persistence: { status: mayPersistCandidate ? 'applied' : 'skipped' },
    generation: { status: 'skipped' },
    delivery: { status: 'skipped' }
  };

  if (manualReviewPause && mayPersistCandidate) {
    if (!wasManualReviewPauseApplied(executionResult.manualReviewPause)) {
      return result;
    }
    try {
      await manualReviewNotifier(
        prisma,
        executionResult.manualReviewPause?.candidate || executionResult.candidate,
        {
          reason: manualReviewPause.reason,
          inboundText: input?.turn?.rawText || '',
          reviewType: 'question',
          extra: { source: 'functional_core' }
        }
      );
    } catch (error) {
      throw new ConversationDecisionExecutionError('notification', error);
    }
  }

  if (!mayReply || !resolvedDecision.reply) return result;

  let outbound;
  try {
    outbound = await resolveOutboundText(input, resolvedDecision, llmService);
    result.generation = { status: outbound.status };
  } catch (error) {
    throw new ConversationDecisionExecutionError('generation', error);
  }

  if (!outbound.text || !maySendOutbound || !whatsappClient) return result;

  const safetyCheck = sanitizeOutboundReply({
    reply: outbound.text,
    vacancy: input?.vacancy ?? null,
    candidate: {
      id: input?.candidate?.id ?? null,
      ...asRecord(input?.candidate?.facts)
    },
    currentStep: normalizedDecision.mutations.nextStep
      ?? input?.candidate?.facts?.currentStep
      ?? null,
    source: 'functional_core'
  });
  const textToSend = safetyCheck.reply;

  try {
    const delivery = await deliverResolvedReply({
      prisma,
      input,
      decision: resolvedDecision,
      text: textToSend,
      whatsappClient,
      deliveryAuthority: automaticOutboundDelivery,
      deliveryAdapters
    });
    result.delivery = {
      status: delivery?.suppressed ? 'suppressed' : 'sent'
    };
  } catch (error) {
    throw new ConversationDecisionExecutionError('delivery', error);
  }

  return result;
}

export default executeConversationDecision;
