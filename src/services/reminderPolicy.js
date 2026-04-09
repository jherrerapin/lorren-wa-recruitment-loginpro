export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INTERVIEW_KEEPALIVE_THRESHOLD_MS = Number.parseInt(
  process.env.INTERVIEW_KEEPALIVE_THRESHOLD_MS || String(2 * 60 * 60 * 1000),
  10
) || (2 * 60 * 60 * 1000);
export const INTERVIEW_CONFIRMATION_LEAD_MS = Number.parseInt(
  process.env.INTERVIEW_CONFIRMATION_LEAD_MS || String(60 * 60 * 1000),
  10
) || (60 * 60 * 1000);
export const INTERVIEW_NO_RESPONSE_LEAD_MS = Number.parseInt(
  process.env.INTERVIEW_NO_RESPONSE_LEAD_MS || String(10 * 60 * 1000),
  10
) || (10 * 60 * 1000);

const REMINDER_ELIGIBLE_STEPS = new Set([
  'GREETING_SENT',
  'COLLECTING_DATA',
  'CONFIRMING_DATA',
  'ASK_CV'
]);

const INTERVIEW_KEEPALIVE_ELIGIBLE_STEPS = new Set([
  'SCHEDULING',
  'SCHEDULED'
]);

export function getWhatsappWindowState(lastInboundAt, now = new Date()) {
  if (!lastInboundAt) {
    return {
      isOpen: false,
      expiresAt: null,
      remainingMs: 0
    };
  }

  const inboundDate = new Date(lastInboundAt);
  const expiresAt = new Date(inboundDate.getTime() + WHATSAPP_WINDOW_MS);
  const remainingMs = expiresAt.getTime() - now.getTime();

  return {
    isOpen: remainingMs > 0,
    expiresAt,
    remainingMs
  };
}

export function isWithinWhatsappWindow(lastInboundAt) {
  return getWhatsappWindowState(lastInboundAt).isOpen;
}

export function canScheduleReminderPolicy(candidate) {
  if (!candidate) return false;
  if (candidate.botPaused) return false;
  if (candidate.status === 'RECHAZADO') return false;
  if (candidate.currentStep === 'DONE') return false;
  if (!REMINDER_ELIGIBLE_STEPS.has(candidate.currentStep)) return false;
  if (candidate.reminderState === 'SENT' || candidate.lastReminderAt) return false;
  if (!candidate.lastInboundAt) return false;
  return true;
}

export function canSendInterviewKeepalivePolicy(candidate, now = new Date()) {
  if (!candidate) return false;
  if (candidate.botPaused) return false;
  if (candidate.status === 'RECHAZADO' || candidate.status === 'CONTRATADO') return false;
  if (candidate.currentStep !== 'SCHEDULING') return false;
  const windowState = getWhatsappWindowState(candidate.lastInboundAt, now);
  if (!windowState.isOpen) return false;
  return windowState.remainingMs <= INTERVIEW_KEEPALIVE_THRESHOLD_MS;
}

export function canSendInterviewConfirmationPromptPolicy(candidate, booking, now = new Date()) {
  if (!candidate || !booking) return false;
  if (candidate.botPaused) return false;
  if (candidate.status === 'RECHAZADO' || candidate.status === 'CONTRATADO') return false;
  if (candidate.currentStep !== 'SCHEDULED') return false;
  if (booking.status !== 'SCHEDULED') return false;
  if (booking.reminderSentAt) return false;

  const scheduledAt = new Date(booking.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) return false;

  const remainingMs = scheduledAt.getTime() - now.getTime();
  if (remainingMs < 0) return false;
  return remainingMs <= INTERVIEW_CONFIRMATION_LEAD_MS;
}

export function shouldMarkInterviewNoResponsePolicy(candidate, booking, now = new Date()) {
  if (!candidate || !booking) return false;
  if (candidate.botPaused) return false;
  if (booking.status !== 'SCHEDULED') return false;
  if (!booking.reminderSentAt) return false;
  if (booking.reminderResponse) return false;

  const reminderSentAt = new Date(booking.reminderSentAt);
  const scheduledAt = new Date(booking.scheduledAt);
  if (Number.isNaN(reminderSentAt.getTime()) || Number.isNaN(scheduledAt.getTime())) return false;

  const lastInboundAt = candidate.lastInboundAt ? new Date(candidate.lastInboundAt) : null;
  if (lastInboundAt && !Number.isNaN(lastInboundAt.getTime()) && lastInboundAt.getTime() >= reminderSentAt.getTime()) {
    return false;
  }

  return now.getTime() >= scheduledAt.getTime() - INTERVIEW_NO_RESPONSE_LEAD_MS;
}
