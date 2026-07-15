/**
 * Primera autoridad compartida de InterviewBooking.
 * Inventario vigente: docs/architecture/interview-booking-transition-inventory.md
 */
export const ACTIVE_INTERVIEW_BOOKING_STATUSES = Object.freeze(['SCHEDULED', 'CONFIRMED']);

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

function validateCreateContract(prisma) {
  return Boolean(
    prisma
    && prisma.interviewBooking
    && typeof prisma.interviewBooking.findFirst === 'function'
    && typeof prisma.interviewBooking.updateMany === 'function'
    && typeof prisma.interviewBooking.create === 'function'
  );
}

function validateCancelContract(prisma) {
  return Boolean(
    prisma
    && prisma.interviewBooking
    && typeof prisma.interviewBooking.updateMany === 'function'
  );
}

async function findExactActiveBooking(prisma, { candidateId, vacancyId, slotId, scheduledAt }) {
  return prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      vacancyId,
      slotId,
      scheduledAt,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    }
  });
}

async function findAnyActiveBooking(prisma, candidateId) {
  return prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    orderBy: { scheduledAt: 'asc' }
  });
}

export async function createScheduledInterviewBooking(prisma, input = {}) {
  if (!validateCreateContract(prisma)) {
    throw new Error('interview_booking_create_prisma_contract_invalid');
  }
  requireInputObject(input, 'interview_booking_create_input');

  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const vacancyId = requireNonEmptyString(input.vacancyId, 'vacancy_id');
  const slotId = requireNonEmptyString(input.slotId, 'slot_id');
  const scheduledAt = requireTimestamp(input.scheduledAt, 'scheduled_at');
  const reminderWindowClosed = input.reminderWindowClosed === undefined ? false : input.reminderWindowClosed;
  const replacementStatus = requireNonEmptyString(input.replacementStatus ?? 'RESCHEDULED', 'replacement_status');

  const exactExisting = await findExactActiveBooking(prisma, {
    candidateId,
    vacancyId,
    slotId,
    scheduledAt
  });
  if (exactExisting) return exactExisting;

  await prisma.interviewBooking.updateMany({
    where: {
      candidateId,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    data: {
      status: replacementStatus,
      reminderWindowClosed: true
    }
  });

  try {
    return await prisma.interviewBooking.create({
      data: {
        candidateId,
        vacancyId,
        slotId,
        scheduledAt,
        reminderWindowClosed
      }
    });
  } catch (error) {
    const active = await findAnyActiveBooking(prisma, candidateId);
    if (active) return active;
    throw error;
  }
}

export async function cancelActiveInterviewBookings(prisma, input = {}) {
  if (!validateCancelContract(prisma)) {
    throw new Error('interview_booking_cancel_prisma_contract_invalid');
  }
  requireInputObject(input, 'interview_booking_cancel_input');

  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const replacementStatus = requireNonEmptyString(input.replacementStatus ?? 'CANCELLED', 'replacement_status');

  return prisma.interviewBooking.updateMany({
    where: {
      candidateId,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    data: {
      status: replacementStatus,
      reminderWindowClosed: true
    }
  });
}
