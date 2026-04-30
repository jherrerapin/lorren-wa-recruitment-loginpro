export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INTERVIEW_KEEPALIVE_THRESHOLD_MS = Number.parseInt(
  process.env.INTERVIEW_KEEPALIVE_THRESHOLD_MS || String(2 * 60 * 60 * 1000),
  10
) || (2 * 60 * 60 * 1000);

const REMINDER_ELIGIBLE_STEPS = new Set([
  'GREETING_SENT',
  'COLLECTING_DATA',
  'CONFIRMING_DATA',
  'ASK_CV',
  'SCHEDULING'
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
  if (!INTERVIEW_KEEPALIVE_ELIGIBLE_STEPS.has(candidate.currentStep)) return false;
  const windowState = getWhatsappWindowState(candidate.lastInboundAt, now);
  if (!windowState.isOpen) return false;
  return windowState.remainingMs <= INTERVIEW_KEEPALIVE_THRESHOLD_MS;
}
