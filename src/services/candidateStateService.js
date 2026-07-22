import { CandidateStatus, ConversationStep, ReminderState } from '@prisma/client';
import { buildManualWhatsAppOpenCandidateUpdate } from './adminOutboundPolicy.js';
import { buildInboundResumeUpdate } from './botAutomationPolicy.js';
import { hasMaterialProfileData, isSilentProfileCaptureMode } from './silentProfileCapture.js';

export const MANUAL_OUTBOUND_SENDING_MODE = 'manual_outbound_sending';
export const MANUAL_OUTBOUND_UNKNOWN_MODE = 'manual_outbound_delivery_unknown';

function requireCandidateClient(client) {
  if (
    typeof client?.candidate?.updateMany !== 'function'
    || typeof client?.candidate?.findUnique !== 'function'
  ) {
    throw new TypeError('candidate_state_client_required');
  }
  return client;
}

function requireCandidateId(candidateId) {
  const normalized = String(candidateId || '').trim();
  if (!normalized) throw new TypeError('candidate_id_required');
  return normalized;
}

function requireNonEmptyString(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`${fieldName}_required`);
  return normalized;
}

function requireCandidateAdminRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (!['dev', 'admin'].includes(role)) {
    throw new TypeError('candidate_admin_role_invalid');
  }
  return role;
}

function requireValidDate(value, fieldName) {
  if (value === null || typeof value === 'boolean') {
    throw new TypeError(`${fieldName}_invalid`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${fieldName}_invalid`);
  return date;
}

function normalizeNullableDate(value, fieldName) {
  return value == null ? null : requireValidDate(value, fieldName);
}

function normalizeExpectedPauseSnapshot(expected = {}, { requirePaused = false } = {}) {
  if (typeof expected?.botPaused !== 'boolean') {
    throw new TypeError('candidate_expected_pause_snapshot_required');
  }
  if (requirePaused && expected.botPaused !== true) {
    throw new TypeError('candidate_expected_paused_state_required');
  }

  return {
    botPaused: expected.botPaused,
    botPausedAt: normalizeNullableDate(expected.botPausedAt, 'candidate_expected_bot_paused_at'),
    botPausedBy: expected.botPausedBy ?? null,
    botPauseReason: expected.botPauseReason ?? null,
    botResumeMode: expected.botResumeMode ?? null
  };
}

function normalizeManualWhatsAppOpenSnapshot(expected = {}, role) {
  const snapshot = normalizeExpectedPauseSnapshot(expected);
  if (role === 'dev') {
    return {
      ...snapshot,
      devLastSeenAt: normalizeNullableDate(expected.devLastSeenAt, 'candidate_expected_dev_last_seen_at')
    };
  }

  return {
    ...snapshot,
    status: requireNonEmptyString(expected.status, 'candidate_expected_status')
  };
}

function normalizeManualOutboundSnapshot(expected = {}) {
  return {
    ...normalizeExpectedPauseSnapshot(expected),
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_expected_reminder_scheduled_for'
    ),
    reminderState: requireNonEmptyString(expected.reminderState, 'candidate_expected_reminder_state'),
    lastOutboundAt: normalizeNullableDate(expected.lastOutboundAt, 'candidate_expected_last_outbound_at')
  };
}

function normalizeSupervisorReviewSnapshot(expected = {}) {
  return {
    ...normalizeExpectedPauseSnapshot(expected, { requirePaused: true }),
    lastOutboundAt: normalizeNullableDate(expected.lastOutboundAt, 'candidate_expected_last_outbound_at')
  };
}

function millisecondDateFilter(value) {
  if (value == null) return null;
  return {
    gte: value,
    lt: new Date(value.getTime() + 1)
  };
}

function manualOutboundExpectedWhere(snapshot) {
  return {
    ...snapshot,
    botPausedAt: millisecondDateFilter(snapshot.botPausedAt),
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    lastOutboundAt: millisecondDateFilter(snapshot.lastOutboundAt)
  };
}

function supervisorReviewExpectedWhere(snapshot) {
  return {
    ...snapshot,
    botPausedAt: millisecondDateFilter(snapshot.botPausedAt),
    lastOutboundAt: millisecondDateFilter(snapshot.lastOutboundAt)
  };
}

function requireClaimedManualOutboundSnapshot(expected = {}) {
  const snapshot = normalizeManualOutboundSnapshot(expected);
  if (!snapshot.botPaused || snapshot.botResumeMode !== MANUAL_OUTBOUND_SENDING_MODE) {
    throw new TypeError('candidate_manual_outbound_expected_sending_required');
  }
  return snapshot;
}

async function loadCandidateTransitionMiss(client, candidateId, extra = {}) {
  const candidate = await client.candidate.findUnique({
    where: { id: candidateId }
  });
  return { count: 0, candidate, ...extra };
}

async function applyConditionalCandidatePauseTransition(client, {
  candidateId,
  expected,
  data
}) {
  const result = await client.candidate.updateMany({
    where: {
      id: candidateId,
      ...expected
    },
    data
  });

  const candidate = await client.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate
  };
}

export async function resumeCandidateAutomationOnInbound(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeExpectedPauseSnapshot(input.expected, { requirePaused: true });
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_resume_now');

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected,
    data: buildInboundResumeUpdate(now)
  });
}

export async function pauseCandidateAutomationFromAdmin(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeExpectedPauseSnapshot(input.expected);
  const actor = requireNonEmptyString(input.actor, 'candidate_pause_actor');
  const reason = requireNonEmptyString(input.reason, 'candidate_pause_reason');
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_pause_now');

  if (expected.botPaused) {
    return loadCandidateTransitionMiss(candidateClient, candidateId);
  }

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected,
    data: {
      botPaused: true,
      botPausedAt: now,
      botPausedBy: actor,
      botPauseReason: reason,
      botResumeMode: 'manual_resume_dashboard',
      reminderScheduledFor: null,
      reminderState: 'CANCELLED'
    }
  });
}

export async function resumeCandidateAutomationFromAdmin(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeExpectedPauseSnapshot(input.expected);

  if (!expected.botPaused) {
    return loadCandidateTransitionMiss(candidateClient, candidateId);
  }

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected,
    data: {
      botPaused: false,
      botPausedAt: null,
      botPausedBy: null,
      botPauseReason: null,
      botResumeMode: 'manual_resume_dashboard',
      reminderScheduledFor: null,
      reminderState: 'CANCELLED'
    }
  });
}

export async function recordManualWhatsAppOpen(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const role = requireCandidateAdminRole(input.role);
  const actor = requireNonEmptyString(input.actor, 'candidate_whatsapp_open_actor');
  const expected = normalizeManualWhatsAppOpenSnapshot(input.expected, role);
  const reason = input.reason === undefined
    ? 'Conversacion tomada manualmente por apertura de WhatsApp desde dashboard'
    : requireNonEmptyString(input.reason, 'candidate_whatsapp_open_reason');
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_whatsapp_open_now');

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected,
    data: buildManualWhatsAppOpenCandidateUpdate({
      now,
      role,
      pausedBy: actor,
      reason
    })
  });
}

export async function claimManualOutboundDelivery(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeManualOutboundSnapshot(input.expected);
  const actor = requireNonEmptyString(input.actor, 'candidate_manual_outbound_actor');
  const reason = requireNonEmptyString(input.reason, 'candidate_manual_outbound_reason');
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_manual_outbound_now');

  if ([MANUAL_OUTBOUND_SENDING_MODE, MANUAL_OUTBOUND_UNKNOWN_MODE].includes(expected.botResumeMode)) {
    return loadCandidateTransitionMiss(candidateClient, candidateId, {
      blockedReason: expected.botResumeMode
    });
  }

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: manualOutboundExpectedWhere(expected),
    data: {
      botPaused: true,
      botPausedAt: now,
      botPausedBy: actor,
      botPauseReason: reason,
      botResumeMode: MANUAL_OUTBOUND_SENDING_MODE,
      reminderScheduledFor: null,
      reminderState: 'CANCELLED'
    }
  });
}

export async function finalizeManualOutboundDelivery(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = requireClaimedManualOutboundSnapshot(input.expected);
  const sentAtInput = input.sentAt === undefined ? new Date() : input.sentAt;
  const sentAt = requireValidDate(sentAtInput, 'candidate_manual_outbound_sent_at');

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: manualOutboundExpectedWhere(expected),
    data: {
      lastOutboundAt: sentAt,
      botResumeMode: 'manual_resume_dashboard'
    }
  });
}

export async function restoreManualOutboundDelivery(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = requireClaimedManualOutboundSnapshot(input.expected);
  const previous = normalizeManualOutboundSnapshot(input.previous);

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: manualOutboundExpectedWhere(expected),
    data: previous
  });
}

export async function markManualOutboundDeliveryUnknown(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = requireClaimedManualOutboundSnapshot(input.expected);

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: manualOutboundExpectedWhere(expected),
    data: {
      botResumeMode: MANUAL_OUTBOUND_UNKNOWN_MODE
    }
  });
}

export async function completeSupervisorReviewAfterDelivery(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeSupervisorReviewSnapshot(input.expected);
  const sentAtInput = input.sentAt === undefined ? new Date() : input.sentAt;
  const sentAt = requireValidDate(sentAtInput, 'candidate_supervisor_review_sent_at');

  if ([MANUAL_OUTBOUND_SENDING_MODE, MANUAL_OUTBOUND_UNKNOWN_MODE].includes(expected.botResumeMode)) {
    return loadCandidateTransitionMiss(candidateClient, candidateId, {
      blockedReason: expected.botResumeMode
    });
  }

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: supervisorReviewExpectedWhere(expected),
    data: {
      botPaused: false,
      botPausedAt: null,
      botPausedBy: null,
      botPauseReason: null,
      botResumeMode: null,
      lastOutboundAt: sentAt
    }
  });
}


function normalizeConversationEnginePauseSnapshot(expected) {
  const requiredFields = [
    'botPaused',
    'botPausedAt',
    'botPausedBy',
    'botPauseReason',
    'botResumeMode',
    'reminderScheduledFor',
    'reminderState'
  ];
  if (
    !expected
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || requiredFields.some((field) => !Object.hasOwn(expected, field))
  ) {
    throw new TypeError('candidate_engine_pause_snapshot_required');
  }

  const pauseSnapshot = normalizeExpectedPauseSnapshot(expected);
  return {
    botPaused: pauseSnapshot.botPaused,
    botPausedAt: pauseSnapshot.botPausedAt,
    botPausedBy: requireNullableSnapshotString(
      expected.botPausedBy,
      'candidate_engine_pause_expected_bot_paused_by'
    ),
    botPauseReason: requireNullableSnapshotString(
      expected.botPauseReason,
      'candidate_engine_pause_expected_reason'
    ),
    botResumeMode: requireNullableSnapshotString(
      expected.botResumeMode,
      'candidate_engine_pause_expected_resume_mode'
    ),
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_engine_pause_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_engine_pause_reminder_state'
    )
  };
}

function conversationEnginePauseExpectedWhere(snapshot) {
  return {
    botPaused: snapshot.botPaused,
    botPausedAt: millisecondDateFilter(snapshot.botPausedAt),
    botPausedBy: snapshot.botPausedBy,
    botPauseReason: snapshot.botPauseReason,
    botResumeMode: snapshot.botResumeMode,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function pauseCandidateAutomationFromConversationEngine(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeConversationEnginePauseSnapshot(input.expected);
  const reason = requireNonEmptyString(input.reason, 'candidate_engine_pause_reason');
  const pausedAtInput = input.pausedAt === undefined ? new Date() : input.pausedAt;
  const pausedAt = requireValidDate(pausedAtInput, 'candidate_engine_pause_at');

  if (expected.botPaused) {
    return loadCandidateTransitionMiss(candidateClient, candidateId, {
      blockedReason: 'already_paused'
    });
  }

  const transition = await applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: conversationEnginePauseExpectedWhere(expected),
    data: {
      botPaused: true,
      botPausedAt: pausedAt,
      botPauseReason: reason,
      reminderScheduledFor: null,
      reminderState: ReminderState.CANCELLED
    }
  });

  return {
    ...transition,
    expected,
    pausedAt,
    reason,
    nextReminderState: ReminderState.CANCELLED
  };
}


function normalizeManualReviewPauseSnapshot(expected) {
  const requiredFields = [
    'botPaused',
    'botPausedAt',
    'botPausedBy',
    'botPauseReason',
    'botResumeMode',
    'reminderScheduledFor',
    'reminderState'
  ];
  if (
    !expected
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || requiredFields.some((field) => !Object.hasOwn(expected, field))
  ) {
    throw new TypeError('candidate_manual_review_pause_snapshot_required');
  }

  const pauseSnapshot = normalizeExpectedPauseSnapshot(expected);
  return {
    botPaused: pauseSnapshot.botPaused,
    botPausedAt: pauseSnapshot.botPausedAt,
    botPausedBy: requireNullableSnapshotString(
      expected.botPausedBy,
      'candidate_manual_review_pause_expected_bot_paused_by'
    ),
    botPauseReason: requireNullableSnapshotString(
      expected.botPauseReason,
      'candidate_manual_review_pause_expected_reason'
    ),
    botResumeMode: requireNullableSnapshotString(
      expected.botResumeMode,
      'candidate_manual_review_pause_expected_resume_mode'
    ),
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_manual_review_pause_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_manual_review_pause_reminder_state'
    )
  };
}

function manualReviewPauseExpectedWhere(snapshot) {
  return {
    botPaused: snapshot.botPaused,
    botPausedAt: millisecondDateFilter(snapshot.botPausedAt),
    botPausedBy: snapshot.botPausedBy,
    botPauseReason: snapshot.botPauseReason,
    botResumeMode: snapshot.botResumeMode,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function pauseCandidateAutomationForManualReview(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeManualReviewPauseSnapshot(input.expected);
  const reason = requireNonEmptyString(input.reason, 'candidate_manual_review_pause_reason');
  const pausedAtInput = input.pausedAt === undefined ? new Date() : input.pausedAt;
  const pausedAt = requireValidDate(pausedAtInput, 'candidate_manual_review_pause_at');

  if (expected.botPaused) {
    return loadCandidateTransitionMiss(candidateClient, candidateId, {
      blockedReason: 'already_paused'
    });
  }

  const transition = await applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: manualReviewPauseExpectedWhere(expected),
    data: {
      botPaused: true,
      botPausedAt: pausedAt,
      botPauseReason: reason,
      reminderScheduledFor: null,
      reminderState: ReminderState.CANCELLED
    }
  });

  return {
    ...transition,
    expected,
    pausedAt,
    reason,
    nextReminderState: ReminderState.CANCELLED
  };
}

function requireCandidateMultilineScheduleClient(client) {
  if (typeof client?.candidate?.update !== 'function') {
    throw new TypeError('candidate_multiline_schedule_client_required');
  }
  return client;
}

function requireCandidateMultilineAcquireClient(client) {
  if (typeof client?.candidate?.updateMany !== 'function') {
    throw new TypeError('candidate_multiline_acquire_client_required');
  }
  return client;
}

function requireMultilineWindowMs(value) {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim() === '')
  ) {
    throw new TypeError('candidate_multiline_window_ms_invalid');
  }
  const windowMs = Number(value);
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new TypeError('candidate_multiline_window_ms_invalid');
  }
  return windowMs;
}

function requireMultilineBatchVersion(value) {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim() === '')
  ) {
    throw new TypeError('candidate_multiline_batch_version_invalid');
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('candidate_multiline_batch_version_invalid');
  }
  return version;
}

export async function scheduleCandidateMultilineWindow(client, input = {}) {
  const candidateClient = requireCandidateMultilineScheduleClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const windowMs = requireMultilineWindowMs(input.windowMs);
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_multiline_schedule_now');
  const windowUntil = new Date(now.getTime() + windowMs);

  const updated = await candidateClient.candidate.update({
    where: { id: candidateId },
    data: {
      multilineWindowUntil: windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });
  const batchVersion = requireMultilineBatchVersion(updated?.multilineBatchVersion);

  return { windowMs, windowUntil, batchVersion };
}

export async function acquireCandidateMultilineBatch(client, input = {}) {
  const candidateClient = requireCandidateMultilineAcquireClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const batchVersion = requireMultilineBatchVersion(input.expected?.multilineBatchVersion);
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_multiline_acquire_now');

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      multilineBatchVersion: batchVersion,
      multilineWindowUntil: { lte: now }
    },
    data: {
      multilineWindowUntil: null,
      multilineBatchVersion: { increment: 1 }
    }
  });

  return { count: Number(result?.count || 0) };
}


function requireConversationStep(value, fieldName) {
  if (typeof value !== 'string' || !Object.values(ConversationStep).includes(value)) {
    throw new TypeError(`${fieldName}_invalid`);
  }
  return value;
}

export async function transitionCandidateConversationStep(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expectedStep = requireConversationStep(
    input.expected?.currentStep,
    'candidate_expected_current_step'
  );
  const nextStep = requireConversationStep(input.nextStep, 'candidate_next_step');

  if (expectedStep === nextStep) {
    throw new TypeError('candidate_conversation_step_noop');
  }

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      currentStep: expectedStep
    },
    data: {
      currentStep: nextStep
    }
  });

  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expectedStep,
    nextStep
  };
}

function requireReminderState(value, fieldName) {
  if (typeof value !== 'string' || !Object.values(ReminderState).includes(value)) {
    throw new TypeError(`${fieldName}_invalid`);
  }
  return value;
}

function normalizeNoInterestSnapshot(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new TypeError('candidate_no_interest_reminder_scheduled_for_required');
  }
  if (!Object.hasOwn(expected, 'reminderScheduledFor')) {
    throw new TypeError('candidate_no_interest_reminder_scheduled_for_required');
  }

  return {
    currentStep: requireConversationStep(
      expected.currentStep,
      'candidate_no_interest_current_step'
    ),
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_no_interest_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_no_interest_reminder_state'
    )
  };
}

function noInterestExpectedWhere(snapshot) {
  return {
    currentStep: snapshot.currentStep,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function completeCandidateNoInterestTransition(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeNoInterestSnapshot(input.expected);

  if (expected.currentStep === ConversationStep.DONE) {
    throw new TypeError('candidate_no_interest_already_done');
  }

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...noInterestExpectedWhere(expected)
    },
    data: {
      currentStep: ConversationStep.DONE,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });

  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expected,
    nextStep: ConversationStep.DONE,
    nextReminderState: ReminderState.SKIPPED
  };
}

function requireCandidateStatus(value, fieldName) {
  if (typeof value !== 'string' || !Object.values(CandidateStatus).includes(value)) {
    throw new TypeError(`${fieldName}_invalid`);
  }
  return value;
}

function requireNullableSnapshotString(value, fieldName) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${fieldName}_invalid`);
  return value;
}

function requireStrictDecisionString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${fieldName}_required`);
  }
  return value;
}

function normalizeRequirementRejectionSnapshot(expected) {
  const requiredFields = [
    'currentStep',
    'status',
    'rejectionReason',
    'rejectionDetails',
    'reminderScheduledFor',
    'reminderState'
  ];
  if (
    !expected
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || requiredFields.some((field) => !Object.hasOwn(expected, field))
  ) {
    throw new TypeError('candidate_requirement_rejection_snapshot_required');
  }

  return {
    currentStep: requireConversationStep(
      expected.currentStep,
      'candidate_requirement_rejection_current_step'
    ),
    status: requireCandidateStatus(
      expected.status,
      'candidate_requirement_rejection_status'
    ),
    rejectionReason: requireNullableSnapshotString(
      expected.rejectionReason,
      'candidate_requirement_rejection_expected_reason'
    ),
    rejectionDetails: requireNullableSnapshotString(
      expected.rejectionDetails,
      'candidate_requirement_rejection_expected_details'
    ),
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_requirement_rejection_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_requirement_rejection_reminder_state'
    )
  };
}

function requirementRejectionExpectedWhere(snapshot) {
  return {
    currentStep: snapshot.currentStep,
    status: snapshot.status,
    rejectionReason: snapshot.rejectionReason,
    rejectionDetails: snapshot.rejectionDetails,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function completeCandidateRequirementRejection(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeRequirementRejectionSnapshot(input.expected);
  const reason = requireStrictDecisionString(
    input.reason,
    'candidate_requirement_rejection_reason'
  );
  const details = requireStrictDecisionString(
    input.details,
    'candidate_requirement_rejection_details'
  );

  if (expected.status === CandidateStatus.RECHAZADO) {
    return loadCandidateTransitionMiss(candidateClient, candidateId, {
      blockedReason: 'already_rejected'
    });
  }

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...requirementRejectionExpectedWhere(expected)
    },
    data: {
      currentStep: ConversationStep.DONE,
      status: CandidateStatus.RECHAZADO,
      rejectionReason: reason,
      rejectionDetails: details,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });

  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expected,
    reason,
    details,
    nextStep: ConversationStep.DONE,
    nextStatus: CandidateStatus.RECHAZADO,
    nextReminderState: ReminderState.SKIPPED
  };
}




function normalizeCandidateInterviewCancellationReminderSnapshot(expected) {
  const requiredFields = [
    'reminderScheduledFor',
    'reminderState'
  ];
  if (
    !expected
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || requiredFields.some((field) => !Object.hasOwn(expected, field))
  ) {
    throw new TypeError('candidate_interview_cancellation_reminder_snapshot_required');
  }

  return {
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_interview_cancellation_expected_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_interview_cancellation_expected_reminder_state'
    )
  };
}

function candidateInterviewCancellationReminderExpectedWhere(snapshot) {
  return {
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function reflectCandidateInterviewCancellationReminder(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);

  if (Object.hasOwn(input, 'nextReminderState') || Object.hasOwn(input, 'nextStep')) {
    throw new TypeError('candidate_interview_cancellation_next_state_not_allowed');
  }
  if (Object.hasOwn(input, 'update') || Object.hasOwn(input, 'data')) {
    throw new TypeError('candidate_interview_cancellation_patch_not_allowed');
  }

  const expected = normalizeCandidateInterviewCancellationReminderSnapshot(input.expected);
  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...candidateInterviewCancellationReminderExpectedWhere(expected)
    },
    data: {
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });
  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expected,
    nextReminderState: ReminderState.SKIPPED
  };
}

const CANDIDATE_INTERVIEW_RESCHEDULE_PROGRESS_ORIGINS = new Set([
  ConversationStep.SCHEDULING,
  ConversationStep.SCHEDULED
]);

function normalizeCandidateInterviewRescheduleProgressSnapshot(expected) {
  const requiredFields = [
    'currentStep',
    'reminderScheduledFor',
    'reminderState'
  ];
  if (
    !expected
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || requiredFields.some((field) => !Object.hasOwn(expected, field))
  ) {
    throw new TypeError('candidate_interview_reschedule_snapshot_required');
  }

  const currentStep = requireConversationStep(
    expected.currentStep,
    'candidate_interview_reschedule_expected_current_step'
  );
  if (!CANDIDATE_INTERVIEW_RESCHEDULE_PROGRESS_ORIGINS.has(currentStep)) {
    throw new TypeError('candidate_interview_reschedule_expected_step_invalid');
  }

  return {
    currentStep,
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_interview_reschedule_expected_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_interview_reschedule_expected_reminder_state'
    )
  };
}

function candidateInterviewRescheduleProgressExpectedWhere(snapshot) {
  return {
    currentStep: snapshot.currentStep,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function reflectCandidateInterviewRescheduleProgress(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);

  if (Object.hasOwn(input, 'nextStep')) {
    throw new TypeError('candidate_interview_reschedule_next_step_not_allowed');
  }
  if (Object.hasOwn(input, 'update') || Object.hasOwn(input, 'data')) {
    throw new TypeError('candidate_interview_reschedule_patch_not_allowed');
  }

  const expected = normalizeCandidateInterviewRescheduleProgressSnapshot(input.expected);
  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...candidateInterviewRescheduleProgressExpectedWhere(expected)
    },
    data: {
      currentStep: ConversationStep.SCHEDULING,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });
  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expected,
    nextStep: ConversationStep.SCHEDULING,
    nextReminderState: ReminderState.SKIPPED
  };
}

export const CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS = Object.freeze({
  MANUAL_BOOKING_CREATED: 'MANUAL_BOOKING_CREATED',
  LAST_BOOKING_DELETED: 'LAST_BOOKING_DELETED'
});

const CANDIDATE_ADMIN_INTERVIEW_PROGRESS_DESTINATIONS = new Map([
  [
    CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.MANUAL_BOOKING_CREATED,
    ConversationStep.SCHEDULED
  ],
  [
    CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS.LAST_BOOKING_DELETED,
    ConversationStep.SCHEDULING
  ]
]);

function requireCandidateAdminInterviewProgressAction(value) {
  const action = String(value || '').trim();
  if (!CANDIDATE_ADMIN_INTERVIEW_PROGRESS_DESTINATIONS.has(action)) {
    throw new TypeError('candidate_admin_interview_action_invalid');
  }
  return action;
}

export async function reflectCandidateAdminInterviewProgress(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const action = requireCandidateAdminInterviewProgressAction(input.action);
  const expectedStep = requireConversationStep(
    input.expected?.currentStep,
    'candidate_admin_interview_expected_current_step'
  );
  const actor = requireNonEmptyString(input.actor, 'candidate_admin_interview_actor');
  const reason = requireNonEmptyString(input.reason, 'candidate_admin_interview_reason');

  if (Object.hasOwn(input, 'nextStep')) {
    throw new TypeError('candidate_admin_interview_next_step_not_allowed');
  }

  const nextStep = CANDIDATE_ADMIN_INTERVIEW_PROGRESS_DESTINATIONS.get(action);
  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      currentStep: expectedStep
    },
    data: {
      currentStep: nextStep
    }
  });
  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    action,
    actor,
    reason,
    expectedStep,
    nextStep
  };
}


const CONSENT_STEP_DESTINATIONS = new Set([
  ConversationStep.COLLECTING_DATA,
  ConversationStep.GREETING_SENT,
  ConversationStep.DONE
]);

export async function transitionCandidateConsentStep(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expectedStep = requireConversationStep(
    input.expected?.currentStep,
    'candidate_consent_expected_current_step'
  );
  const nextStep = requireConversationStep(input.nextStep, 'candidate_consent_next_step');

  if (!CONSENT_STEP_DESTINATIONS.has(nextStep)) {
    throw new TypeError('candidate_consent_next_step_invalid');
  }

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      currentStep: expectedStep
    },
    data: {
      currentStep: nextStep
    }
  });

  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expectedStep,
    nextStep
  };
}


const VACANCY_FIRST_GATE_DESTINATIONS = new Set([
  ConversationStep.GREETING_SENT,
  ConversationStep.COLLECTING_DATA,
  ConversationStep.CONFIRMING_DATA,
  ConversationStep.ASK_CV
]);

const VACANCY_FIRST_GATE_UPDATE_FIELDS = new Set([
  'currentStep',
  'vacancyId',
  'botResumeMode',
  'reminderScheduledFor',
  'reminderState'
]);

function normalizeVacancyFirstGateSnapshot(expected) {
  const requiredFields = [
    'currentStep',
    'vacancyId',
    'botResumeMode',
    'reminderScheduledFor',
    'reminderState'
  ];
  if (
    !expected
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || requiredFields.some((field) => !Object.hasOwn(expected, field))
  ) {
    throw new TypeError('candidate_vacancy_first_gate_snapshot_required');
  }

  return {
    currentStep: requireConversationStep(expected.currentStep, 'candidate_vacancy_first_gate_expected_step'),
    vacancyId: requireNullableSnapshotString(expected.vacancyId, 'candidate_vacancy_first_gate_expected_vacancy_id'),
    botResumeMode: requireNullableSnapshotString(expected.botResumeMode, 'candidate_vacancy_first_gate_expected_resume_mode'),
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_vacancy_first_gate_expected_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_vacancy_first_gate_expected_reminder_state'
    )
  };
}

function normalizeVacancyFirstGateUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    throw new TypeError('candidate_vacancy_first_gate_update_required');
  }
  const fields = Object.keys(update);
  if (!fields.length || !Object.hasOwn(update, 'currentStep')) {
    throw new TypeError('candidate_vacancy_first_gate_current_step_required');
  }
  const invalidField = fields.find((field) => !VACANCY_FIRST_GATE_UPDATE_FIELDS.has(field));
  if (invalidField) {
    throw new TypeError(`candidate_vacancy_first_gate_update_field_not_allowed:${invalidField}`);
  }

  const currentStep = requireConversationStep(update.currentStep, 'candidate_vacancy_first_gate_next_step');
  if (!VACANCY_FIRST_GATE_DESTINATIONS.has(currentStep)) {
    throw new TypeError('candidate_vacancy_first_gate_next_step_invalid');
  }

  const normalized = { currentStep };
  if (Object.hasOwn(update, 'vacancyId')) {
    normalized.vacancyId = requireNullableSnapshotString(
      update.vacancyId,
      'candidate_vacancy_first_gate_vacancy_id'
    );
  }
  if (Object.hasOwn(update, 'botResumeMode')) {
    normalized.botResumeMode = requireNullableSnapshotString(
      update.botResumeMode,
      'candidate_vacancy_first_gate_resume_mode'
    );
  }
  if (Object.hasOwn(update, 'reminderScheduledFor')) {
    normalized.reminderScheduledFor = normalizeNullableDate(
      update.reminderScheduledFor,
      'candidate_vacancy_first_gate_reminder_scheduled_for'
    );
  }
  if (Object.hasOwn(update, 'reminderState')) {
    normalized.reminderState = requireReminderState(
      update.reminderState,
      'candidate_vacancy_first_gate_reminder_state'
    );
  }
  return normalized;
}

function vacancyFirstGateExpectedWhere(expected) {
  return {
    currentStep: expected.currentStep,
    vacancyId: expected.vacancyId,
    botResumeMode: expected.botResumeMode,
    reminderScheduledFor: millisecondDateFilter(expected.reminderScheduledFor),
    reminderState: expected.reminderState
  };
}

export async function applyCandidateVacancyFirstGateDecision(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeVacancyFirstGateSnapshot(input.expected);
  const update = normalizeVacancyFirstGateUpdate(input.update);

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...vacancyFirstGateExpectedWhere(expected)
    },
    data: update
  });
  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expected,
    update
  };
}



const SILENT_PROFILE_CAPTURE_PROFILE_FIELDS = new Set([
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'locality',
  'neighborhood',
  'medicalRestrictions',
  'transportMode',
  'experienceInfo',
  'experienceTime',
  'experienceSummary',
  'gender'
]);

const SILENT_PROFILE_CAPTURE_UPDATE_FIELDS = new Set([
  ...SILENT_PROFILE_CAPTURE_PROFILE_FIELDS,
  'currentStep',
  'botResumeMode',
  'reminderScheduledFor',
  'reminderState'
]);

const SILENT_PROFILE_CAPTURE_GENDERS = new Set(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN']);

function normalizeSilentProfileExpectedValue(field, value) {
  if (field === 'age') {
    if (value === null) return null;
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('candidate_silent_profile_capture_expected_age_invalid');
    }
    return value;
  }

  if (field === 'gender') {
    if (value === null) return null;
    if (typeof value !== 'string' || !SILENT_PROFILE_CAPTURE_GENDERS.has(value)) {
      throw new TypeError('candidate_silent_profile_capture_expected_gender_invalid');
    }
    return value;
  }

  return requireNullableSnapshotString(
    value,
    `candidate_silent_profile_capture_expected_${field}`
  );
}

function normalizeSilentProfileUpdateValue(field, value) {
  if (field === 'age') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('candidate_silent_profile_capture_age_invalid');
    }
    return value;
  }

  if (field === 'gender') {
    if (typeof value !== 'string' || !SILENT_PROFILE_CAPTURE_GENDERS.has(value)) {
      throw new TypeError('candidate_silent_profile_capture_gender_invalid');
    }
    return value;
  }

  return requireStrictDecisionString(
    value,
    `candidate_silent_profile_capture_${field}`
  );
}

function normalizeSilentProfileCaptureUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    throw new TypeError('candidate_silent_profile_capture_update_required');
  }

  const fields = Object.keys(update);
  const requiredFields = ['currentStep', 'reminderScheduledFor', 'reminderState'];
  if (requiredFields.some((field) => !Object.hasOwn(update, field))) {
    throw new TypeError('candidate_silent_profile_capture_progress_update_required');
  }

  const invalidField = fields.find((field) => !SILENT_PROFILE_CAPTURE_UPDATE_FIELDS.has(field));
  if (invalidField) {
    throw new TypeError(`candidate_silent_profile_capture_update_field_not_allowed:${invalidField}`);
  }

  const currentStep = requireConversationStep(
    update.currentStep,
    'candidate_silent_profile_capture_next_step'
  );
  if (currentStep !== ConversationStep.GREETING_SENT) {
    throw new TypeError('candidate_silent_profile_capture_next_step_invalid');
  }
  if (update.reminderScheduledFor !== null) {
    throw new TypeError('candidate_silent_profile_capture_reminder_scheduled_for_must_be_null');
  }

  const reminderState = requireReminderState(
    update.reminderState,
    'candidate_silent_profile_capture_reminder_state'
  );
  if (reminderState !== ReminderState.SKIPPED) {
    throw new TypeError('candidate_silent_profile_capture_reminder_state_invalid');
  }

  const normalized = {
    currentStep,
    reminderScheduledFor: null,
    reminderState
  };

  if (Object.hasOwn(update, 'botResumeMode')) {
    normalized.botResumeMode = requireNullableSnapshotString(
      update.botResumeMode,
      'candidate_silent_profile_capture_resume_mode'
    );
  }

  const profileFields = fields.filter((field) => SILENT_PROFILE_CAPTURE_PROFILE_FIELDS.has(field));
  for (const field of profileFields) {
    normalized[field] = normalizeSilentProfileUpdateValue(field, update[field]);
  }

  if (!hasMaterialProfileData(normalized)) {
    throw new TypeError('candidate_silent_profile_capture_material_profile_required');
  }

  return { update: normalized, profileFields };
}

function normalizeSilentProfileCaptureSnapshot(expected, profileFields) {
  const requiredFields = [
    'currentStep',
    'vacancyId',
    'botResumeMode',
    'reminderScheduledFor',
    'reminderState'
  ];
  if (
    !expected
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || requiredFields.some((field) => !Object.hasOwn(expected, field))
  ) {
    throw new TypeError('candidate_silent_profile_capture_snapshot_required');
  }

  const vacancyId = requireNullableSnapshotString(
    expected.vacancyId,
    'candidate_silent_profile_capture_expected_vacancy_id'
  );
  if (vacancyId !== null) {
    throw new TypeError('candidate_silent_profile_capture_vacancy_must_be_null');
  }

  const botResumeMode = requireNullableSnapshotString(
    expected.botResumeMode,
    'candidate_silent_profile_capture_expected_resume_mode'
  );
  if (!isSilentProfileCaptureMode(botResumeMode)) {
    throw new TypeError('candidate_silent_profile_capture_mode_invalid');
  }

  const snapshot = {
    currentStep: requireConversationStep(
      expected.currentStep,
      'candidate_silent_profile_capture_expected_step'
    ),
    vacancyId,
    botResumeMode,
    reminderScheduledFor: normalizeNullableDate(
      expected.reminderScheduledFor,
      'candidate_silent_profile_capture_expected_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(
      expected.reminderState,
      'candidate_silent_profile_capture_expected_reminder_state'
    )
  };

  for (const field of profileFields) {
    if (!Object.hasOwn(expected, field)) {
      throw new TypeError(`candidate_silent_profile_capture_expected_field_required:${field}`);
    }
    snapshot[field] = normalizeSilentProfileExpectedValue(field, expected[field]);
  }

  return snapshot;
}

function silentProfileCaptureExpectedWhere(expected, profileFields) {
  const where = {
    currentStep: expected.currentStep,
    vacancyId: expected.vacancyId,
    botResumeMode: expected.botResumeMode,
    reminderScheduledFor: millisecondDateFilter(expected.reminderScheduledFor),
    reminderState: expected.reminderState
  };

  for (const field of profileFields) {
    where[field] = expected[field];
  }

  return where;
}

export async function applyCandidateSilentProfileCapture(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const normalized = normalizeSilentProfileCaptureUpdate(input.update);
  const expected = normalizeSilentProfileCaptureSnapshot(
    input.expected,
    normalized.profileFields
  );

  if (
    Object.hasOwn(normalized.update, 'botResumeMode')
    && normalized.update.botResumeMode !== expected.botResumeMode
  ) {
    throw new TypeError('candidate_silent_profile_capture_resume_mode_must_be_preserved');
  }

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...silentProfileCaptureExpectedWhere(expected, normalized.profileFields)
    },
    data: normalized.update
  });
  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    expected,
    update: normalized.update,
    profileFields: normalized.profileFields
  };
}
