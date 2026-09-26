const SCHEDULE_INTENTS = new Set([
  'SCHEDULE_INTERVIEW',
  'BOOK_INTERVIEW',
  'ACCEPT_INTERVIEW_SLOT',
  'RESERVE_SLOT'
]);

const RESCHEDULE_INTENTS = new Set([
  'RESCHEDULE_INTERVIEW',
  'REQUEST_RESCHEDULE'
]);

const CANCEL_INTENTS = new Set([
  'CANCEL_INTERVIEW',
  'CANCEL_BOOKING',
  'CANCEL_ATTENDANCE'
]);

function getIntent(input = {}) {
  return String(input?.interpretation?.intent || '').trim().toUpperCase();
}

function schedulingEnabled(vacancy = null) {
  if (!vacancy) return false;
  return vacancy.schedulingEnabled === true
    || vacancy.interviewSchedulingEnabled === true;
}

function validIsoDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function normalizeSlot(slot = null) {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return null;

  const startsAt = String(slot.startsAt || '').trim();
  const endsAt = String(slot.endsAt || '').trim();
  const timezone = String(slot.timezone || '').trim();

  if (!validIsoDateTime(startsAt) || !validIsoDateTime(endsAt) || !timezone) {
    return null;
  }

  if (Date.parse(endsAt) <= Date.parse(startsAt)) return null;

  return { startsAt, endsAt, timezone };
}

function getInterpretedSlot(input = {}) {
  return normalizeSlot(input?.interpretation?.scheduling?.slot || null);
}

function getPendingSchedulingAction(input = {}) {
  const actions = Array.isArray(input?.pending?.actions) ? input.pending.actions : [];
  return actions.find((action) => [
    'scheduling_slot',
    'interview_slot',
    'reserve_slot'
  ].includes(String(action?.type || ''))) || null;
}

function getPendingSlot(input = {}) {
  const action = getPendingSchedulingAction(input);
  return normalizeSlot(action?.payload?.slot || action?.payload || null);
}

function resolveRequestedSlot(input = {}) {
  return getInterpretedSlot(input) || getPendingSlot(input);
}

/**
 * Pure scheduling policy. It describes the scheduling effect; the imperative
 * shell owns availability queries, reservation locks, persistence and retries.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function schedulingPolicy(input) {
  const intent = getIntent(input);
  const isSchedule = SCHEDULE_INTENTS.has(intent);
  const isReschedule = RESCHEDULE_INTENTS.has(intent);
  const isCancellation = CANCEL_INTENTS.has(intent);

  if (!isSchedule && !isReschedule && !isCancellation) return {};
  if (!schedulingEnabled(input?.vacancy)) return {};

  if (isCancellation) {
    return {
      scheduling: {
        action: 'cancel_booking'
      }
    };
  }

  const slot = resolveRequestedSlot(input);
  if (slot) {
    return {
      scheduling: {
        action: 'reserve_slot',
        slot
      }
    };
  }

  return {
    scheduling: {
      action: 'suggest_slots'
    }
  };
}

export default schedulingPolicy;
