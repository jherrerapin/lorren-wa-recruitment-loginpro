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
  const timezone = String(slot.timezone || '').trim();
  const slotId = slot.slotId == null ? null : String(slot.slotId).trim() || null;

  if (!validIsoDateTime(startsAt) || !timezone) {
    return null;
  }

  return { slotId, startsAt, timezone };
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

function getSuggestedSlots(input = {}) {
  const actions = Array.isArray(input?.pending?.actions)
    ? input.pending.actions
    : [];

  const action = actions.find((item) => (
    String(item?.type || '').trim() === 'suggested_slots'
  ));

  const slots = Array.isArray(action?.payload?.slots)
    ? action.payload.slots
    : [];

  return slots
    .map(normalizeSlot)
    .filter(Boolean);
}

function selectedSlotIndex(rawText = '') {
  const normalized = String(rawText || '').trim();
  const match = normalized.match(/^(\d{1,2})(?:[.)-])?$/);
  if (!match) return null;

  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0
    ? index
    : null;
}

function resolveNumberedSuggestedSlot(input = {}) {
  const index = selectedSlotIndex(input?.turn?.rawText || '');
  if (index === null) return null;

  const slots = getSuggestedSlots(input);
  return slots[index] || null;
}

function resolveRequestedSlot(input = {}) {
  return getInterpretedSlot(input)
    || resolveNumberedSuggestedSlot(input)
    || getPendingSlot(input);
}

/**
 * Pure scheduling policy. It describes the scheduling effect; the imperative
 * shell owns availability queries, reservation locks, persistence and retries.
 *
 * A numbered response can resolve a previously offered slot even when the NLU
 * classified the turn generically, because the pending suggested-slots action
 * is the deterministic conversational context for that number.
 *
 * @param {import('../../contracts/ConversationTurnInputSchema.js').ConversationTurnInput} input
 * @returns {Promise<object>} Partial<ConversationDecision>
 */
export async function schedulingPolicy(input) {
  if (!schedulingEnabled(input?.vacancy)) return {};

  const numberedSlot = resolveNumberedSuggestedSlot(input);
  if (numberedSlot) {
    return {
      scheduling: {
        action: 'reserve_slot',
        slot: numberedSlot
      }
    };
  }

  const intent = getIntent(input);
  const isSchedule = SCHEDULE_INTENTS.has(intent);
  const isReschedule = RESCHEDULE_INTENTS.has(intent);
  const isCancellation = CANCEL_INTENTS.has(intent);

  if (!isSchedule && !isReschedule && !isCancellation) return {};

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
