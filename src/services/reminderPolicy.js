const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

const REMINDER_ELIGIBLE_STEPS = new Set([
  'GREETING_SENT',
  'COLLECTING_DATA',
  'CONFIRMING_DATA',
  'ASK_CV'
]);

export function isWithinWhatsappWindow(lastInboundAt) {
  if (!lastInboundAt) return false;
  return (Date.now() - new Date(lastInboundAt).getTime()) <= WHATSAPP_WINDOW_MS;
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
