import {
  evaluateInterviewBookingTransition,
  InterviewBookingStatus,
  InterviewBookingTransitionAction,
  isActiveInterviewBookingStatus
} from '../modules/interviews/domain/interviewBookingTransitionPolicy.js';

/**
 * Primera autoridad compartida de InterviewBooking.
 * Inventario vigente: docs/architecture/interview-booking-transition-inventory.md
 */
export const ACTIVE_INTERVIEW_BOOKING_STATUSES = Object.freeze(
  Object.values(InterviewBookingStatus).filter(isActiveInterviewBookingStatus)
);

const MAX_SERIALIZABLE_RETRIES = 3;
const SERIALIZABLE_ISOLATION_LEVEL = 'Serializable';

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

async function createOrReplaceInsideTransaction(client, input) {
  const activeBookings = await listActiveBookings(client, input.candidateId);
  const exactExisting = activeBookings.find((booking) => isExactBooking(booking, input));
  if (exactExisting) return exactExisting;

  if (!activeBookings.length) {
    assertAllowedTransition(evaluateInterviewBookingTransition({
      action: InterviewBookingTransitionAction.CREATE_INITIAL,
      currentStatus: null
    }));
  } else {
    for (const booking of activeBookings) {
      assertAllowedTransition(evaluateInterviewBookingTransition({
        action: InterviewBookingTransitionAction.REQUEST_RESCHEDULE,
        currentStatus: booking.status
      }));
    }
  }

  const created = await client.interviewBooking.create({
    data: {
      candidateId: input.candidateId,
      vacancyId: input.vacancyId,
      slotId: input.slotId,
      scheduledAt: input.scheduledAt,
      reminderWindowClosed: input.reminderWindowClosed
    }
  });
  const replacementBookingId = requireNonEmptyString(created?.id, 'created_booking_id');

  for (const currentStatus of ACTIVE_INTERVIEW_BOOKING_STATUSES) {
    assertAllowedTransition(evaluateInterviewBookingTransition({
      action: InterviewBookingTransitionAction.COMPLETE_RESCHEDULE,
      currentStatus,
      replacementBookingId
    }));
  }

  await client.interviewBooking.updateMany({
    where: {
      candidateId: input.candidateId,
      id: { not: replacementBookingId },
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    data: {
      status: InterviewBookingStatus.RESCHEDULED,
      reminderWindowClosed: true
    }
  });

  return created;
}

async function runSerializableTransaction(prisma, input) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => createOrReplaceInsideTransaction(tx, input),
        { isolationLevel: SERIALIZABLE_ISOLATION_LEVEL }
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionConflict(error) || attempt === MAX_SERIALIZABLE_RETRIES) {
        throw error;
      }
    }
  }
  throw lastError;
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
