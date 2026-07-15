export const InterviewBookingStatus = Object.freeze({
  SCHEDULED: 'SCHEDULED',
  CONFIRMED: 'CONFIRMED',
  ATTENDED: 'ATTENDED',
  NO_RESPONSE: 'NO_RESPONSE',
  RESCHEDULED: 'RESCHEDULED',
  NO_SHOW: 'NO_SHOW',
  CANCELLED: 'CANCELLED'
});

export const InterviewBookingTransitionAction = Object.freeze({
  CREATE_INITIAL: 'CREATE_INITIAL',
  CONFIRM_ATTENDANCE: 'CONFIRM_ATTENDANCE',
  CANCEL: 'CANCEL',
  REQUEST_RESCHEDULE: 'REQUEST_RESCHEDULE',
  COMPLETE_RESCHEDULE: 'COMPLETE_RESCHEDULE',
  MARK_NO_RESPONSE: 'MARK_NO_RESPONSE',
  MARK_ATTENDED: 'MARK_ATTENDED',
  MARK_NO_SHOW: 'MARK_NO_SHOW',
  RECORD_LATE_RESPONSE: 'RECORD_LATE_RESPONSE'
});

const KNOWN_STATUSES = new Set(Object.values(InterviewBookingStatus));
const KNOWN_ACTIONS = new Set(Object.values(InterviewBookingTransitionAction));
const ACTIVE_STATUSES = new Set([
  InterviewBookingStatus.SCHEDULED,
  InterviewBookingStatus.CONFIRMED
]);
const AUTOMATION_CLOSED_STATUSES = new Set([
  InterviewBookingStatus.ATTENDED,
  InterviewBookingStatus.NO_RESPONSE,
  InterviewBookingStatus.RESCHEDULED,
  InterviewBookingStatus.NO_SHOW,
  InterviewBookingStatus.CANCELLED
]);

function requireKnownAction(value) {
  const action = String(value ?? '').trim().toUpperCase();
  if (!KNOWN_ACTIONS.has(action)) throw new Error('interview_booking_transition_action_invalid');
  return action;
}

function normalizeCurrentStatus(value, { allowEmpty = false } = {}) {
  const status = String(value ?? '').trim().toUpperCase();
  if (!status && allowEmpty) return null;
  if (!KNOWN_STATUSES.has(status)) throw new Error('interview_booking_status_invalid');
  return status;
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label}_required`);
  return normalized;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || typeof value === 'boolean') {
    throw new Error(`${label}_invalid`);
  }
  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${label}_invalid`);
  return timestamp;
}

function requireTransitionInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('interview_booking_transition_input_invalid');
  }
  return value;
}

function allowedResult({ action, currentStatus, nextStatus, reason, metadata = {} }) {
  return {
    allowed: true,
    action,
    currentStatus,
    nextStatus,
    statusChanged: currentStatus !== nextStatus,
    reason,
    metadata
  };
}

function rejectedResult({ action, currentStatus, reason }) {
  return {
    allowed: false,
    action,
    currentStatus,
    nextStatus: currentStatus,
    statusChanged: false,
    reason,
    metadata: {}
  };
}

function transitionOrIdempotent({ action, currentStatus, allowedOrigins, nextStatus, reason }) {
  if (currentStatus === nextStatus) {
    return allowedResult({
      action,
      currentStatus,
      nextStatus,
      reason: `${reason}_idempotent`
    });
  }
  if (!allowedOrigins.has(currentStatus)) {
    return rejectedResult({
      action,
      currentStatus,
      reason: 'transition_origin_not_allowed'
    });
  }
  return allowedResult({ action, currentStatus, nextStatus, reason });
}

export function isActiveInterviewBookingStatus(value) {
  const status = normalizeCurrentStatus(value);
  return ACTIVE_STATUSES.has(status);
}

export function isInterviewBookingAutomationClosedStatus(value) {
  const status = normalizeCurrentStatus(value);
  return AUTOMATION_CLOSED_STATUSES.has(status);
}

export function evaluateInterviewBookingTransition(input = {}) {
  const transitionInput = requireTransitionInput(input);
  const action = requireKnownAction(transitionInput.action);
  const currentStatus = normalizeCurrentStatus(transitionInput.currentStatus, {
    allowEmpty: action === InterviewBookingTransitionAction.CREATE_INITIAL
  });

  switch (action) {
    case InterviewBookingTransitionAction.CREATE_INITIAL:
      if (currentStatus !== null) {
        return rejectedResult({ action, currentStatus, reason: 'booking_already_exists' });
      }
      return allowedResult({
        action,
        currentStatus,
        nextStatus: InterviewBookingStatus.SCHEDULED,
        reason: 'initial_booking_created'
      });

    case InterviewBookingTransitionAction.CONFIRM_ATTENDANCE:
      return transitionOrIdempotent({
        action,
        currentStatus,
        allowedOrigins: new Set([InterviewBookingStatus.SCHEDULED]),
        nextStatus: InterviewBookingStatus.CONFIRMED,
        reason: 'attendance_confirmed'
      });

    case InterviewBookingTransitionAction.CANCEL:
      return transitionOrIdempotent({
        action,
        currentStatus,
        allowedOrigins: new Set([
          InterviewBookingStatus.SCHEDULED,
          InterviewBookingStatus.CONFIRMED,
          InterviewBookingStatus.NO_RESPONSE
        ]),
        nextStatus: InterviewBookingStatus.CANCELLED,
        reason: 'booking_cancelled'
      });

    case InterviewBookingTransitionAction.REQUEST_RESCHEDULE:
      if (!ACTIVE_STATUSES.has(currentStatus)) {
        return rejectedResult({ action, currentStatus, reason: 'transition_origin_not_allowed' });
      }
      return allowedResult({
        action,
        currentStatus,
        nextStatus: currentStatus,
        reason: 'reschedule_requested_without_closing_booking',
        metadata: { requiresReplacement: true }
      });

    case InterviewBookingTransitionAction.COMPLETE_RESCHEDULE: {
      if (!ACTIVE_STATUSES.has(currentStatus) && currentStatus !== InterviewBookingStatus.RESCHEDULED) {
        return rejectedResult({ action, currentStatus, reason: 'transition_origin_not_allowed' });
      }
      const replacementBookingId = requireNonEmptyString(
        transitionInput.replacementBookingId,
        'replacement_booking_id'
      );
      return allowedResult({
        action,
        currentStatus,
        nextStatus: InterviewBookingStatus.RESCHEDULED,
        reason: currentStatus === InterviewBookingStatus.RESCHEDULED
          ? 'booking_rescheduled_idempotent'
          : 'booking_rescheduled_with_replacement',
        metadata: { replacementBookingId }
      });
    }

    case InterviewBookingTransitionAction.MARK_NO_RESPONSE:
      return transitionOrIdempotent({
        action,
        currentStatus,
        allowedOrigins: new Set([InterviewBookingStatus.SCHEDULED]),
        nextStatus: InterviewBookingStatus.NO_RESPONSE,
        reason: 'booking_marked_no_response'
      });

    case InterviewBookingTransitionAction.MARK_ATTENDED:
      return transitionOrIdempotent({
        action,
        currentStatus,
        allowedOrigins: new Set([
          InterviewBookingStatus.SCHEDULED,
          InterviewBookingStatus.CONFIRMED,
          InterviewBookingStatus.NO_RESPONSE
        ]),
        nextStatus: InterviewBookingStatus.ATTENDED,
        reason: 'booking_marked_attended'
      });

    case InterviewBookingTransitionAction.MARK_NO_SHOW:
      return transitionOrIdempotent({
        action,
        currentStatus,
        allowedOrigins: new Set([
          InterviewBookingStatus.SCHEDULED,
          InterviewBookingStatus.CONFIRMED,
          InterviewBookingStatus.NO_RESPONSE
        ]),
        nextStatus: InterviewBookingStatus.NO_SHOW,
        reason: 'booking_marked_no_show'
      });

    case InterviewBookingTransitionAction.RECORD_LATE_RESPONSE: {
      if (currentStatus !== InterviewBookingStatus.NO_RESPONSE) {
        return rejectedResult({ action, currentStatus, reason: 'transition_origin_not_allowed' });
      }
      const respondedAt = normalizeTimestamp(transitionInput.respondedAt, 'responded_at');
      return allowedResult({
        action,
        currentStatus,
        nextStatus: currentStatus,
        reason: 'late_response_recorded_without_implicit_status_change',
        metadata: { respondedAt }
      });
    }

    default:
      throw new Error('interview_booking_transition_action_invalid');
  }
}
