import {
  evaluateInterviewBookingTransition,
  InterviewBookingStatus,
  InterviewBookingTransitionAction,
  isActiveInterviewBookingStatus
} from '../modules/interviews/domain/interviewBookingTransitionPolicy.js';

/**
 * Autoridad compartida de InterviewBooking.
 * Inventario vigente: docs/architecture/interview-booking-transition-inventory.md
 */
export const ACTIVE_INTERVIEW_BOOKING_STATUSES = Object.freeze(
  Object.values(InterviewBookingStatus).filter(isActiveInterviewBookingStatus)
);

const MAX_SERIALIZABLE_RETRIES = 3;
const SERIALIZABLE_ISOLATION_LEVEL = 'Serializable';
const REMINDER_RESPONSE_INTENTS = new Set([
  'confirm_attendance',
  'cancel_interview',
  'reschedule_interview'
]);
const ACTIVE_INTERVIEW_BOOKING_STATUSES_SET = new Set(ACTIVE_INTERVIEW_BOOKING_STATUSES);
const KNOWN_INTERVIEW_BOOKING_STATUSES_SET = new Set(Object.values(InterviewBookingStatus));
const ADMIN_INTERVIEW_ACTION_TO_TRANSITION_ACTION = Object.freeze({
  confirmed: InterviewBookingTransitionAction.CONFIRM_ATTENDANCE,
  attended: InterviewBookingTransitionAction.MARK_ATTENDED,
  no_response: InterviewBookingTransitionAction.MARK_NO_RESPONSE,
  no_show: InterviewBookingTransitionAction.MARK_NO_SHOW,
  cancelled: InterviewBookingTransitionAction.CANCEL,
  rescheduled: InterviewBookingTransitionAction.REQUEST_RESCHEDULE
});

function requireNonEmptyString(value, label) {
  if (value === null || value === undefined) {
    throw new Error(`${label}_required`);
  }
  if (typeof value !== 'string') {
    throw new Error(`${label}_invalid`);
  }
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}_required`);
  return normalized;
}

function requireInputObject(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label}_invalid`);
  }
  return input;
}

function requireTimestamp(value, label) {
  if (value === null || value === undefined || typeof value === 'boolean') {
    throw new Error(`${label}_invalid`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${label}_invalid`);
  return timestamp;
}

function requireAllowedStatus(value, allowedStatuses, label) {
  const normalized = requireNonEmptyString(value, label).toUpperCase();
  if (!allowedStatuses.has(normalized)) throw new Error(`${label}_not_allowed`);
  return normalized;
}

function requireBookingClient(client, methods, label) {
  const booking = client?.interviewBooking;
  if (!booking || methods.some((method) => typeof booking[method] !== 'function')) {
    throw new Error(`${label}_prisma_contract_invalid`);
  }
  return client;
}

function assertAllowedTransition(result) {
  if (!result.allowed) {
    throw new Error(`interview_booking_transition_not_allowed:${result.reason}`);
  }
  return result;
}

function isSameTimestamp(left, right) {
  return new Date(left).getTime() === new Date(right).getTime();
}

function isExactBooking(booking, input) {
  return booking.candidateId === input.candidateId
    && booking.vacancyId === input.vacancyId
    && booking.slotId === input.slotId
    && isSameTimestamp(booking.scheduledAt, input.scheduledAt);
}

function isRetryableTransactionConflict(error) {
  return error?.code === 'P2034';
}

function isUniqueConstraintConflict(error) {
  return error?.code === 'P2002';
}

function hasTransactionApi(client) {
  return typeof client?.$transaction === 'function';
}

function normalizeReminderResponseIntent(value) {
  const intent = requireNonEmptyString(value, 'interview_reminder_intent').toLowerCase();
  if (!REMINDER_RESPONSE_INTENTS.has(intent)) {
    throw new Error('interview_reminder_intent_not_allowed');
  }
  return intent;
}

function normalizeAdministrativeInterviewAction(value) {
  const action = requireNonEmptyString(value, 'interview_admin_action').toLowerCase();
  if (!Object.hasOwn(ADMIN_INTERVIEW_ACTION_TO_TRANSITION_ACTION, action)) {
    throw new Error('interview_admin_action_not_allowed');
  }
  return action;
}

function resolveReminderResponseTransition(intent, currentStatus) {
  const actionByIntent = {
    confirm_attendance: InterviewBookingTransitionAction.CONFIRM_ATTENDANCE,
    cancel_interview: InterviewBookingTransitionAction.CANCEL,
    reschedule_interview: InterviewBookingTransitionAction.REQUEST_RESCHEDULE
  };
  return assertAllowedTransition(evaluateInterviewBookingTransition({
    action: actionByIntent[intent],
    currentStatus
  }));
}

async function listActiveBookings(client, candidateId) {
  return client.interviewBooking.findMany({
    where: {
      candidateId,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    orderBy: { scheduledAt: 'asc' }
  });
}

async function findExactActiveBooking(client, input) {
  return client.interviewBooking.findFirst({
    where: {
      candidateId: input.candidateId,
      vacancyId: input.vacancyId,
      slotId: input.slotId,
      scheduledAt: input.scheduledAt,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    }
  });
}

async function createBookingRow(client, input) {
  return client.interviewBooking.create({
    data: {
      candidateId: input.candidateId,
      vacancyId: input.vacancyId,
      slotId: input.slotId,
      scheduledAt: input.scheduledAt,
      reminderWindowClosed: input.reminderWindowClosed
    }
  });
}

async function createOrReplaceInsideTransaction(client, input) {
  const activeBookings = await listActiveBookings(client, input.candidateId);
  const exactExisting = activeBookings.find((booking) => isExactBooking(booking, input));
  if (exactExisting) return exactExisting;

  if (!activeBookings.length) {
    assertAllowedTransition(evaluateInterviewBookingTransition({
      action: InterviewBookingTransitionAction.CREATE_INITIAL,
      currentStatus: null
    }));
    return createBookingRow(client, input);
  }

  for (const booking of activeBookings) {
    assertAllowedTransition(evaluateInterviewBookingTransition({
      action: InterviewBookingTransitionAction.REQUEST_RESCHEDULE,
      currentStatus: booking.status
    }));
  }

  await client.interviewBooking.updateMany({
    where: {
      candidateId: input.candidateId,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    data: {
      status: InterviewBookingStatus.RESCHEDULED,
      reminderWindowClosed: true
    }
  });

  const created = await createBookingRow(client, input);
  const replacementBookingId = requireNonEmptyString(created?.id, 'created_booking_id');

  for (const booking of activeBookings) {
    assertAllowedTransition(evaluateInterviewBookingTransition({
      action: InterviewBookingTransitionAction.COMPLETE_RESCHEDULE,
      currentStatus: booking.status,
      replacementBookingId
    }));
  }

  return created;
}

async function runSerializableTransaction(prisma, input) {
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => createOrReplaceInsideTransaction(tx, input),
        { isolationLevel: SERIALIZABLE_ISOLATION_LEVEL }
      );
    } catch (error) {
      if (!isRetryableTransactionConflict(error) || attempt === MAX_SERIALIZABLE_RETRIES) {
        throw error;
      }
    }
  }
}

export async function createScheduledInterviewBooking(prisma, input = {}) {
  requireBookingClient(
    prisma,
    ['findMany', 'findFirst', 'updateMany', 'create'],
    'interview_booking_create'
  );
  const createInput = requireInputObject(input, 'interview_booking_create_input');
  const normalized = {
    candidateId: requireNonEmptyString(createInput.candidateId, 'candidate_id'),
    vacancyId: requireNonEmptyString(createInput.vacancyId, 'vacancy_id'),
    slotId: requireNonEmptyString(createInput.slotId, 'slot_id'),
    scheduledAt: requireTimestamp(createInput.scheduledAt, 'scheduled_at'),
    reminderWindowClosed: createInput.reminderWindowClosed === undefined
      ? false
      : createInput.reminderWindowClosed,
    replacementStatus: requireAllowedStatus(
      createInput.replacementStatus ?? InterviewBookingStatus.RESCHEDULED,
      new Set([InterviewBookingStatus.RESCHEDULED]),
      'replacement_status'
    )
  };

  if (!hasTransactionApi(prisma)) {
    return createOrReplaceInsideTransaction(prisma, normalized);
  }

  try {
    return await runSerializableTransaction(prisma, normalized);
  } catch (error) {
    if (isUniqueConstraintConflict(error) || isRetryableTransactionConflict(error)) {
      const exactConcurrent = await findExactActiveBooking(prisma, normalized);
      if (exactConcurrent) return exactConcurrent;
    }
    throw error;
  }
}

export async function requestActiveInterviewBookingReschedule(prisma, input = {}) {
  requireBookingClient(prisma, ['findMany'], 'interview_booking_reschedule_request');
  const requestInput = requireInputObject(input, 'interview_booking_reschedule_request_input');
  const candidateId = requireNonEmptyString(requestInput.candidateId, 'candidate_id');
  const activeBookings = await listActiveBookings(prisma, candidateId);

  for (const booking of activeBookings) {
    assertAllowedTransition(evaluateInterviewBookingTransition({
      action: InterviewBookingTransitionAction.REQUEST_RESCHEDULE,
      currentStatus: booking.status
    }));
  }

  return { count: 0 };
}

export async function cancelActiveInterviewBookings(prisma, input = {}) {
  requireBookingClient(prisma, ['updateMany'], 'interview_booking_cancel');
  const cancelInput = requireInputObject(input, 'interview_booking_cancel_input');
  const candidateId = requireNonEmptyString(cancelInput.candidateId, 'candidate_id');
  requireAllowedStatus(
    cancelInput.replacementStatus ?? InterviewBookingStatus.CANCELLED,
    new Set([InterviewBookingStatus.CANCELLED]),
    'replacement_status'
  );

  for (const currentStatus of ACTIVE_INTERVIEW_BOOKING_STATUSES) {
    assertAllowedTransition(evaluateInterviewBookingTransition({
      action: InterviewBookingTransitionAction.CANCEL,
      currentStatus
    }));
  }

  return prisma.interviewBooking.updateMany({
    where: {
      candidateId,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    data: {
      status: InterviewBookingStatus.CANCELLED,
      reminderWindowClosed: true
    }
  });
}

export async function closeUnclaimedInterviewReminderWindow(prisma, input = {}) {
  requireBookingClient(prisma, ['updateMany'], 'interview_reminder_window_close');
  const closeInput = requireInputObject(input, 'interview_reminder_window_close_input');
  const bookingId = requireNonEmptyString(closeInput.bookingId, 'booking_id');

  return prisma.interviewBooking.updateMany({
    where: {
      id: bookingId,
      reminderSentAt: null,
      reminderWindowClosed: false
    },
    data: {
      reminderWindowClosed: true
    }
  });
}

export async function claimInterviewBookingReminder(prisma, input = {}) {
  requireBookingClient(prisma, ['updateMany'], 'interview_reminder_claim');
  const claimInput = requireInputObject(input, 'interview_reminder_claim_input');
  const bookingId = requireNonEmptyString(claimInput.bookingId, 'booking_id');
  const candidateId = requireNonEmptyString(claimInput.candidateId, 'candidate_id');
  const now = requireTimestamp(claimInput.now, 'reminder_claimed_at');
  const windowStart = requireTimestamp(claimInput.windowStart, 'reminder_window_start');
  const windowEnd = requireTimestamp(claimInput.windowEnd, 'reminder_window_end');
  if (windowStart > windowEnd) throw new Error('reminder_window_invalid');

  return prisma.interviewBooking.updateMany({
    where: {
      id: bookingId,
      candidateId,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES },
      reminderSentAt: null,
      reminderWindowClosed: false,
      scheduledAt: {
        gte: windowStart,
        lte: windowEnd
      }
    },
    data: {
      reminderSentAt: now,
      reminderWindowClosed: true
    }
  });
}

export async function markInterviewBookingNoResponse(prisma, input = {}) {
  requireBookingClient(prisma, ['updateMany'], 'interview_no_response');
  const noResponseInput = requireInputObject(input, 'interview_no_response_input');
  const bookingId = requireNonEmptyString(noResponseInput.bookingId, 'booking_id');
  const candidateId = requireNonEmptyString(noResponseInput.candidateId, 'candidate_id');
  const now = requireTimestamp(noResponseInput.now, 'no_response_window_start');
  const windowEnd = requireTimestamp(noResponseInput.windowEnd, 'no_response_window_end');
  if (now > windowEnd) throw new Error('no_response_window_invalid');

  assertAllowedTransition(evaluateInterviewBookingTransition({
    action: InterviewBookingTransitionAction.MARK_NO_RESPONSE,
    currentStatus: InterviewBookingStatus.SCHEDULED
  }));

  return prisma.interviewBooking.updateMany({
    where: {
      id: bookingId,
      candidateId,
      status: InterviewBookingStatus.SCHEDULED,
      reminderSentAt: { not: null },
      reminderResponse: null,
      scheduledAt: {
        gte: now,
        lte: windowEnd
      }
    },
    data: {
      status: InterviewBookingStatus.NO_RESPONSE,
      reminderWindowClosed: true
    }
  });
}

export async function applyInterviewReminderResponse(prisma, input = {}) {
  requireBookingClient(prisma, ['updateMany'], 'interview_reminder_response');
  const responseInput = requireInputObject(input, 'interview_reminder_response_input');
  const bookingId = requireNonEmptyString(responseInput.bookingId, 'booking_id');
  const currentStatus = requireAllowedStatus(
    responseInput.currentStatus,
    ACTIVE_INTERVIEW_BOOKING_STATUSES_SET,
    'current_status'
  );
  const responseText = requireNonEmptyString(responseInput.responseText, 'reminder_response');
  const intent = normalizeReminderResponseIntent(responseInput.intent);
  const transition = resolveReminderResponseTransition(intent, currentStatus);

  const result = await prisma.interviewBooking.updateMany({
    where: {
      id: bookingId,
      status: currentStatus
    },
    data: {
      status: transition.nextStatus,
      reminderResponse: responseText,
      reminderWindowClosed: true
    }
  });
  const wasApplied = result.count > 0;

  return {
    count: result.count,
    intent,
    previousStatus: currentStatus,
    nextStatus: wasApplied ? transition.nextStatus : currentStatus,
    statusChanged: wasApplied && transition.statusChanged
  };
}

export async function applyAdministrativeInterviewBookingAction(prisma, input = {}) {
  requireBookingClient(prisma, ['updateMany'], 'interview_admin_transition');
  const transitionInput = requireInputObject(input, 'interview_admin_transition_input');
  const bookingId = requireNonEmptyString(transitionInput.bookingId, 'booking_id');
  const currentStatus = requireAllowedStatus(
    transitionInput.currentStatus,
    KNOWN_INTERVIEW_BOOKING_STATUSES_SET,
    'current_status'
  );
  const action = normalizeAdministrativeInterviewAction(transitionInput.action);
  const transition = assertAllowedTransition(evaluateInterviewBookingTransition({
    action: ADMIN_INTERVIEW_ACTION_TO_TRANSITION_ACTION[action],
    currentStatus
  }));
  const requiresReplacement = transition.metadata?.requiresReplacement === true;

  if (requiresReplacement) {
    return {
      count: 0,
      action,
      previousStatus: currentStatus,
      nextStatus: currentStatus,
      statusChanged: false,
      requiresReplacement: true,
      persisted: false
    };
  }

  const result = await prisma.interviewBooking.updateMany({
    where: { id: bookingId, status: currentStatus },
    data: { status: transition.nextStatus }
  });
  const persisted = result.count > 0;

  return {
    count: result.count,
    action,
    previousStatus: currentStatus,
    nextStatus: persisted ? transition.nextStatus : currentStatus,
    statusChanged: persisted && transition.statusChanged,
    requiresReplacement: false,
    persisted
  };
}
