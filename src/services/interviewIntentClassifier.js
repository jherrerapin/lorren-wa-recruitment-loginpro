import { tryOpenAIParse } from './aiParser.js';
import {
  classifyLocalInterviewIntent,
  detectInterviewIntent,
  hasActiveInterviewBooking
} from './interviewLifecycle.js';

function mapAiRecruitmentIntent(aiResult = {}) {
  const parsedFields = aiResult?.parsedFields || {};
  const textIntent = String(
    aiResult?.extraction?.replyIntent || aiResult?.intent || ''
  ).trim().toLowerCase();

  if (/resched|reagend|reprogram|aplaz|pospon|change.*interview|request_reschedule/.test(textIntent)) {
    return { intent: 'reschedule_interview', confidence: 0.72, source: 'openai_recruitment_intent' };
  }
  if (/cancel|no_interest|decline|no_asist|no_attend/.test(textIntent)) {
    return { intent: 'cancel_interview', confidence: 0.72, source: 'openai_recruitment_intent' };
  }
  if (/confirm|confirmation_yes|attend|asist/.test(textIntent)) {
    return { intent: 'confirm_attendance', confidence: 0.7, source: 'openai_recruitment_intent' };
  }

  const fieldsIntent = classifyLocalInterviewIntent([
    parsedFields.intent,
    parsedFields.replyIntent,
    parsedFields.detectedIntent,
    parsedFields.reason,
    parsedFields.rationale
  ].filter(Boolean).join(' ')).intent;

  if (fieldsIntent !== 'none') {
    return { intent: fieldsIntent, confidence: 0.7, source: 'openai_recruitment_fields' };
  }

  return { intent: 'none', confidence: 0, source: 'openai_recruitment_no_match' };
}

export async function classifyInterviewIntent({
  text = '',
  booking = null,
  now = new Date(),
  parseIntent = tryOpenAIParse
} = {}) {
  const fallbackIntent = detectInterviewIntent({ text, booking, now });
  if (!hasActiveInterviewBooking(booking)) {
    return { intent: 'none', confidence: 0, source: 'no_active_booking', fallbackIntent };
  }

  const local = classifyLocalInterviewIntent(text);
  if (
    local.source === 'semantic_local_logistics'
    || (local.intent !== 'none' && local.intent === fallbackIntent)
  ) {
    return { ...local, fallbackIntent };
  }

  const reminderContext = Boolean(booking?.reminderSentAt || booking?.reminderWindowClosed);
  if (!reminderContext) {
    return { intent: 'none', confidence: 0, source: 'outside_reminder_context', fallbackIntent };
  }

  const aiResult = await parseIntent(text, {
    mode: 'interview_reminder_intent',
    booking: {
      status: booking.status || null,
      scheduledAt: booking.scheduledAt ? new Date(booking.scheduledAt).toISOString() : null,
      reminderSentAt: booking.reminderSentAt ? new Date(booking.reminderSentAt).toISOString() : null,
      reminderWindowClosed: Boolean(booking.reminderWindowClosed)
    }
  }).catch((error) => ({ used: true, status: 'error', error }));

  const aiMapped = mapAiRecruitmentIntent(aiResult);
  if (aiMapped.intent !== 'none') {
    return { ...aiMapped, fallbackIntent };
  }

  return { intent: 'none', confidence: 0, source: 'no_match', fallbackIntent };
}
