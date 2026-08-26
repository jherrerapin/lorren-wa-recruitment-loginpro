const NON_AUTO_RESUMABLE_MODES = new Set([
  'manual_outbound_sending',
  'manual_outbound_delivery_unknown'
]);

const INTERVIEW_COORDINATION_HANDOFF_MODE = 'interview_coordination_handoff';
const INTERVIEW_OUTREACH_SOURCE = 'admin_interview_template';

export const INTERVIEW_COORDINATION_HANDOFF_REPLY_POLICY = Object.freeze({
  situation: 'interview_coordination_handoff_question',
  decision: 'answer_current_question_without_resuming_candidate_flow',
  fallbackIntent: 'interview_coordination_handoff_question',
  source: 'interview_coordination_handoff_reply'
});

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

function normalizeDigits(value = '') {
  return String(value || '').replace(/\D+/g, '');
}

function normalizeComparableText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCoordinatorPhone(value = '') {
  const digits = normalizeDigits(value);
  const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;
  if (!/^3\d{9}$/.test(local)) return null;
  return `+57 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}

function extractCoordinatorPhoneFromText(value = '') {
  const matches = String(value || '').match(/(?:\+?57[\s-]*)?3\d{2}(?:[\s-]*\d{3})(?:[\s-]*\d{4})/g) || [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const formatted = formatCoordinatorPhone(matches[index]);
    if (formatted) return formatted;
  }
  return null;
}

function deliveredInterviewOutreachMessages(recentMessages = []) {
  return (Array.isArray(recentMessages) ? [...recentMessages].reverse() : [])
    .filter((message) => (
      String(message?.direction || '').toUpperCase() === 'OUTBOUND'
      && message?.rawPayload?.source === INTERVIEW_OUTREACH_SOURCE
      && message?.rawPayload?.delivery?.state === 'SENT'
    ));
}

export function shouldAnswerInterviewCoordinationHandoffQuestion(candidate = {}, { isQuestion = false } = {}) {
  return Boolean(
    candidate?.botPaused
    && String(candidate?.botResumeMode || '').trim() === INTERVIEW_COORDINATION_HANDOFF_MODE
    && isQuestion === true
  );
}

export function resolveInterviewCoordinationOutreachContext(recentMessages = []) {
  const delivered = deliveredInterviewOutreachMessages(recentMessages)[0] || null;
  const body = String(delivered?.body || '').trim();
  const scheduleMatch = body.match(/Te esperamos el\s+(.+?)\s+a las\s+(.+?)\s+en\s+(.+?)(?:\.\s*(?:\n|$))/i);
  return {
    message: body || null,
    coordinatorPhone: extractCoordinatorPhoneFromText(body),
    interviewDate: scheduleMatch?.[1]?.trim() || null,
    interviewTime: scheduleMatch?.[2]?.trim() || null,
    interviewAddress: scheduleMatch?.[3]?.trim() || null
  };
}

export function resolveInterviewCoordinationContact(recentMessages = []) {
  return resolveInterviewCoordinationOutreachContext(recentMessages).coordinatorPhone;
}

export function buildInterviewCoordinationFallbackAnswer(inboundText = '', outreachContext = {}, vacancyFallback = '') {
  const normalized = normalizeComparableText(inboundText);
  const date = String(outreachContext?.interviewDate || '').trim();
  const time = String(outreachContext?.interviewTime || '').trim();
  const address = String(outreachContext?.interviewAddress || '').trim();

  if (/\b(cuando|fecha|dia)\b/.test(normalized) && date) {
    return `Tu citación está programada para ${date}${time ? ` a las ${time}` : ''}.`;
  }
  if (/\b(hora|horario)\b/.test(normalized) && time) {
    return `La hora indicada en tu citación es ${time}${date ? ` del ${date}` : ''}.`;
  }
  if (/\b(donde|direccion|ubicacion|lugar|presentarme|presentar)\b/.test(normalized) && address) {
    return `La dirección indicada en tu citación es ${address}.`;
  }

  const fallback = String(vacancyFallback || '').trim();
  if (fallback) return fallback;
  return 'No tengo información suficiente para confirmar ese punto con seguridad desde este chat.';
}

export function appendInterviewCoordinationReferral(answer = '', coordinatorPhone = null) {
  const base = String(answer || '').trim();
  const formattedPhone = formatCoordinatorPhone(coordinatorPhone || '');
  if (formattedPhone) {
    const answerDigits = normalizeDigits(base);
    const phoneDigits = normalizeDigits(formattedPhone);
    if (answerDigits.includes(phoneDigits) && /whatsapp|escr[ií]be|comun[ií]cate/i.test(base)) return base;
    const referral = `Para cualquier cambio o coordinación de esta citación, escríbele por WhatsApp al ${formattedPhone}, que es el número de la persona que gestionó tu citación.`;
    return [base, referral].filter(Boolean).join('\n\n');
  }
  const referral = 'Para cualquier cambio o coordinación de esta citación, escríbele al número de coordinación que aparece en el mensaje de citación anterior.';
  return [base, referral].filter(Boolean).join('\n\n');
}

export function shouldResumeAutomationOnInbound(candidate = {}) {
  if (!candidate?.botPaused) return false;
  const mode = String(candidate.botResumeMode || '').trim();
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
