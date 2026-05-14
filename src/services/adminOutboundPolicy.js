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

export function buildManualWhatsAppOpenCandidateUpdate({
  now = new Date(),
  role = 'dev',
  pausedBy = role || 'dashboard',
  reason = 'Conversacion tomada manualmente por apertura de WhatsApp desde dashboard'
} = {}) {
  const update = buildManualInterventionCandidateUpdate({ now, pausedBy, reason });
  if (role === 'dev') {
    update.devLastSeenAt = now;
  } else {
    update.status = 'CONTACTADO';
  }
  return update;
}
