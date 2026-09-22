import { CandidateStatus, ConversationStep, ReminderState } from '@prisma/client';
import { buildManualWhatsAppOpenCandidateUpdate } from './adminOutboundPolicy.js';
import { buildInboundResumeUpdate, EXPLICIT_ADMIN_PAUSE_MODE } from './botAutomationPolicy.js';
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
      botResumeMode: EXPLICIT_ADMIN_PAUSE_MODE,
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
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_manual_outbound_claim_now');

  if (expected.botPaused) {
    return loadCandidateTransitionMiss(candidateClient, candidateId, {
      blockedReason: 'candidate_already_paused'
    });
  }

  const transition = await applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: manualOutboundExpectedWhere(expected),
    data: {
      botPaused: true,
      botPausedAt: now,
      botPausedBy: actor,
      botPauseReason: 'Envio manual en curso',
      botResumeMode: MANUAL_OUTBOUND_SENDING_MODE,
      reminderScheduledFor: null,
      reminderState: ReminderState.CANCELLED
    }
  });

  return {
    ...transition,
    expected,
    claimedAt: now,
    nextReminderState: ReminderState.CANCELLED
  };
}

export async function finalizeManualOutboundDelivery(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = requireClaimedManualOutboundSnapshot(input.expected);
  const actor = requireNonEmptyString(input.actor, 'candidate_manual_outbound_actor');
  const reason = requireNonEmptyString(input.reason, 'candidate_manual_outbound_reason');
  const sentAtInput = input.sentAt === undefined ? new Date() : input.sentAt;
  const sentAt = requireValidDate(sentAtInput, 'candidate_manual_outbound_sent_at');

  const transition = await applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: manualOutboundExpectedWhere(expected),
    data: {
      botPaused: true,
      botPausedAt: sentAt,
      botPausedBy: actor,
      botPauseReason: reason,
      botResumeMode: EXPLICIT_ADMIN_PAUSE_MODE,
      reminderScheduledFor: null,
      reminderState: ReminderState.CANCELLED,
      lastOutboundAt: sentAt
    }
  });

  return {
    ...transition,
    expected,
    sentAt,
    nextReminderState: ReminderState.CANCELLED
  };
}

export async function markManualOutboundDeliveryUnknown(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = requireClaimedManualOutboundSnapshot(input.expected);
  const actor = requireNonEmptyString(input.actor, 'candidate_manual_outbound_actor');
  const reason = requireNonEmptyString(input.reason, 'candidate_manual_outbound_reason');
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_manual_outbound_unknown_now');

  const transition = await applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: manualOutboundExpectedWhere(expected),
    data: {
      botPaused: true,
      botPausedAt: now,
      botPausedBy: actor,
      botPauseReason: reason,
      botResumeMode: MANUAL_OUTBOUND_UNKNOWN_MODE,
      reminderScheduledFor: null,
      reminderState: ReminderState.CANCELLED
    }
  });

  return {
    ...transition,
    expected,
    markedAt: now,
    nextReminderState: ReminderState.CANCELLED
  };
}

export async function rollbackManualOutboundClaim(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = requireClaimedManualOutboundSnapshot(input.expected);

  const transition = await applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: manualOutboundExpectedWhere(expected),
    data: {
      botPaused: expected.botPaused,
      botPausedAt: expected.botPausedAt,
      botPausedBy: expected.botPausedBy,
      botPauseReason: expected.botPauseReason,
      botResumeMode: expected.botResumeMode,
      reminderScheduledFor: expected.reminderScheduledFor,
      reminderState: expected.reminderState,
      lastOutboundAt: expected.lastOutboundAt
    }
  });

  return {
    ...transition,
    expected
  };
}

export async function acknowledgeSupervisorReview(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeSupervisorReviewSnapshot(input.expected);
  const actor = requireNonEmptyString(input.actor, 'candidate_supervisor_review_actor');
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_supervisor_review_now');

  return applyConditionalCandidatePauseTransition(candidateClient, {
    candidateId,
    expected: supervisorReviewExpectedWhere(expected),
    data: {
      botPaused: true,
      botPausedAt: now,
      botPausedBy: actor,
      botPauseReason: 'Supervisor revisó la conversación',
      botResumeMode: EXPLICIT_ADMIN_PAUSE_MODE
    }
  });
}

function requireExpectedStateObject(expected, fieldName) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new TypeError(`${fieldName}_required`);
  }
  return expected;
}

function requireNullableSnapshotString(value, fieldName) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError(`${fieldName}_invalid`);
  return value;
}

function normalizeVacancyFirstGateSnapshot(expected = {}) {
  const snapshot = requireExpectedStateObject(expected, 'candidate_vacancy_first_expected_snapshot');
  return {
    currentStep: requireConversationStep(snapshot.currentStep, 'candidate_vacancy_first_current_step'),
    vacancyId: requireNullableSnapshotString(snapshot.vacancyId, 'candidate_vacancy_first_vacancy_id'),
    botResumeMode: requireNullableSnapshotString(snapshot.botResumeMode, 'candidate_vacancy_first_bot_resume_mode'),
    reminderScheduledFor: normalizeNullableDate(
      snapshot.reminderScheduledFor,
      'candidate_vacancy_first_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(snapshot.reminderState, 'candidate_vacancy_first_reminder_state')
  };
}

function vacancyFirstGateExpectedWhere(snapshot) {
  return {
    currentStep: snapshot.currentStep,
    vacancyId: snapshot.vacancyId,
    botResumeMode: snapshot.botResumeMode,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor),
    reminderState: snapshot.reminderState
  };
}

export async function applyCandidateVacancyFirstGateDecision(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeVacancyFirstGateSnapshot(input.expected);
  const update = input.update;
  if (!update || typeof update !== 'object' || Array.isArray(update) || !Object.keys(update).length) {
    throw new TypeError('candidate_vacancy_first_update_required');
  }

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

function normalizeSilentProfileCaptureSnapshot(expected = {}) {
  const snapshot = requireExpectedStateObject(expected, 'candidate_silent_capture_expected_snapshot');
  return {
    currentStep: requireConversationStep(snapshot.currentStep, 'candidate_silent_capture_current_step'),
    vacancyId: requireNullableSnapshotString(snapshot.vacancyId, 'candidate_silent_capture_vacancy_id'),
    botResumeMode: requireNullableSnapshotString(snapshot.botResumeMode, 'candidate_silent_capture_bot_resume_mode'),
    reminderScheduledFor: normalizeNullableDate(
      snapshot.reminderScheduledFor,
      'candidate_silent_capture_reminder_scheduled_for'
    ),
    reminderState: requireReminderState(snapshot.reminderState, 'candidate_silent_capture_reminder_state'),
    ...Object.fromEntries(
      Object.entries(snapshot).filter(([field]) => ![
        'currentStep',
        'vacancyId',
        'botResumeMode',
        'reminderScheduledFor',
        'reminderState'
      ].includes(field))
    )
  };
}

function silentProfileCaptureExpectedWhere(snapshot) {
  return {
    ...snapshot,
    reminderScheduledFor: millisecondDateFilter(snapshot.reminderScheduledFor)
  };
}

export async function applyCandidateSilentProfileCapture(client, input = {}) {
  const candidateClient = requireCandidateClient(client);
  const candidateId = requireCandidateId(input.candidateId);
  const expected = normalizeSilentProfileCaptureSnapshot(input.expected);
  const update = input.update;
  if (!update || typeof update !== 'object' || Array.isArray(update) || !Object.keys(update).length) {
    throw new TypeError('candidate_silent_capture_update_required');
  }

  const result = await candidateClient.candidate.updateMany({
    where: {
      id: candidateId,
      ...silentProfileCaptureExpectedWhere(expected)
    },
    data: update
  });

  const candidate = await candidateClient.candidate.findUnique({
    where: { id: candidateId }
  });

  return {
    count: Number(result?.count || 0),
    candidate,
    profileFields: Object.keys(update)
  };
}

function normalizeManualReviewPauseSnapshot(expected = {}) {
  const snapshot = requireExpectedStateObject(expected, 'candidate_manual_review_pause_expected_snapshot');
  return {
    botPaused: Boolean(expected.botPaused),
    botPausedAt: normalizeNullableDate(expected.botPausedAt, 'candidate_manual_review_pause_expected_bot_paused_at'),
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
  const scheduledWindowMs = requireMultilineWindowMs(input.windowMs);
  const nowInput = input.now === undefined ? new Date() : input.now;
  const now = requireValidDate(nowInput, 'candidate_multiline_schedule_now');
  const windowUntil = new Date(now.getTime() + scheduledWindowMs);

  const updated = await candidateClient.candidate.update({
    where: { id: candidateId },
    data: {
      multilineWindowUntil: windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });
  const batchVersion = requireMultilineBatchVersion(updated?.multilineBatchVersion);

  // La ventana real siempre queda persistida. El caller HTTP no debe dormir
  // durante toda la ventana: por defecto devuelve 0 ms y el worker reclama el
  // lote cuando multilineWindowUntil vence. El modo síncrono queda disponible
  // solo para herramientas/pruebas que lo soliciten expresamente.
  const windowMs = input.awaitWindow === true ? scheduledWindowMs : 0;
  return { windowMs, scheduledWindowMs, windowUntil, batchVersion };
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
