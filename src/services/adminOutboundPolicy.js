export function buildTechnicalOutboundCandidateUpdate(now = new Date()) {
  return {
    lastOutboundAt: now,
    reminderScheduledFor: null,
    reminderState: 'CANCELLED'
  };
}

export function buildManualInterventionCandidateUpdate({
  now = new Date(),
  pausedBy = 'dashboard',
  reason = 'Conversacion tomada manualmente desde dashboard'
} = {}) {
  return {
    ...buildTechnicalOutboundCandidateUpdate(now),
    botPaused: true,
    botPausedAt: now,
    botPausedBy: pausedBy,
    botPauseReason: reason,
    botResumeMode: 'manual_resume_dashboard'
  };
}
