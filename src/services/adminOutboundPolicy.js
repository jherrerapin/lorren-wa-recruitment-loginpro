export function buildTechnicalOutboundCandidateUpdate(now = new Date()) {
  return {
    lastOutboundAt: now,
    reminderScheduledFor: null,
    reminderState: 'CANCELLED'
  };
}
