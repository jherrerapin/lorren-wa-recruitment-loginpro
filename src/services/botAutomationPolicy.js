export function shouldBlockAutomation(candidate = {}) {
  return Boolean(candidate?.botPaused);
}

export function describeResumeBehavior({ pendingInboundCount = 0, supportsImmediateReplay = false } = {}) {
  if (pendingInboundCount <= 0) {
    return {
      hasPendingContext: false,
      requiresTrigger: false,
      resumeMode: 'manual_resume_dashboard'
    };
  }

  if (supportsImmediateReplay) {
    return {
      hasPendingContext: true,
      requiresTrigger: false,
      resumeMode: 'manual_resume_replays_pending_context'
    };
  }

  return {
    hasPendingContext: true,
    requiresTrigger: true,
    resumeMode: 'awaiting_inbound_trigger_with_pending_context'
  };
}
