const NON_AUTO_RESUMABLE_MODES = new Set([
  'manual_outbound_sending',
  'manual_outbound_delivery_unknown'
]);

function isManualResumeMode(candidate = {}) {
  const mode = String(candidate?.botResumeMode || '').trim();
  return mode === 'manual_resume_dashboard'
    || mode === 'manual_resume_replays_pending_context'
    || mode === 'awaiting_inbound_trigger_with_pending_context'
    || mode === 'awaiting_inbound_after_human_intervention';
}

function isManualPauseReason(candidate = {}) {
  const reason = String(candidate?.botPauseReason || '').toLowerCase();
  return /manual|humana|humano|dashboard|whatsapp/.test(reason);
}

export function shouldResumeAutomationOnInbound(candidate = {}) {
  if (!candidate?.botPaused) return false;
  const mode = String(candidate?.botResumeMode || '').trim();
  if (NON_AUTO_RESUMABLE_MODES.has(mode)) return false;
  return isManualResumeMode(candidate) || isManualPauseReason(candidate) || Boolean(candidate?.botPausedBy);
}

export function buildInboundResumeUpdate(now = new Date()) {
  return {
    botPaused: false,
    botPausedAt: null,
    botPausedBy: null,
    botPauseReason: null,
    botResumeMode: 'resumed_by_candidate_inbound',
    reminderScheduledFor: null,
    reminderState: 'CANCELLED'
  };
}

export function shouldBlockAutomation(candidate = {}, context = {}) {
  if (!candidate?.botPaused) return false;
  if (context.direction === 'INBOUND' && shouldResumeAutomationOnInbound(candidate)) return false;
  return true;
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
