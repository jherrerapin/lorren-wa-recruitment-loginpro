import { tryOpenAIParse } from './aiParser.js';
import {
  classifyLocalInterviewIntent,
  detectInterviewIntent,
  hasActiveInterviewBooking
} from './interviewLifecycle.js';

const APPOINTMENT_ACTION_INTENTS = new Set(['confirm_attendance', 'cancel_interview', 'reschedule_interview']);

function normalize(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapAiRecruitmentIntent(aiResult = {}) {
  const intent = String(aiResult?.intent || '').trim();
  const parsedFields = aiResult?.parsedFields || {};
  const replyIntent = aiResult?.extraction?.replyIntent || intent;
  const textIntent = String(replyIntent || '').toLowerCase();

  if (/resched|reagend|reprogram|aplaz|pospon|change.*interview|request_reschedule/.test(textIntent)) {
    return { intent: 'reschedule_interview', confidence: 0.72, source: 'openai_recruitment_intent' };
  }
  if (/cancel|no_interest|decline|no_asist|no_attend/.test(textIntent)) {
    return { intent: 'cancel_interview', confidence: 0.72, source: 'openai_recruitment_intent' };
  }
  if (/confirm|confirmation_yes|attend|asist/.test(textIntent)) {
    return { intent: 'confirm_attendance', confidence: 0.7, source: 'openai_recruitment_intent' };
  }

  const combined = normalize([
    parsedFields.intent,
    parsedFields.replyIntent,
    parsedFields.detectedIntent,
    parsedFields.reason,
    parsedFields.rationale
  ].filter(Boolean).join(' '));

  if (/reagend|reprogram|aplaz|pospon|otro horario|otra hora/.test(combined)) {
    return { intent: 'reschedule_interview', confidence: 0.7, source: 'openai_recruitment_fields' };
  }
  if (/cancel|no asistir|no voy|no puedo ir/.test(combined)) {
    return { intent: 'cancel_interview', confidence: 0.7, source: 'openai_recruitment_fields' };
  }
  if (/confirm|si voy|asistire|voy en camino/.test(combined)) {
    return { intent: 'confirm_attendance', confidence: 0.7, source: 'openai_recruitment_fields' };
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
  if (local.intent === 'cancel_interview' || local.intent === 'reschedule_interview') {
    return { ...local, fallbackIntent };
  }
  if (local.intent === 'confirm_attendance' && fallbackIntent === 'confirm_attendance') {
    return { ...local, fallbackIntent };
  }
  if (local.source === 'semantic_local_logistics') {
    return { ...local, fallbackIntent };
  }

  const reminderContext = Boolean(booking?.reminderSentAt || booking?.reminderWindowClosed);
  if (!reminderContext) {
    if (APPOINTMENT_ACTION_INTENTS.has(fallbackIntent)) {
      return { intent: fallbackIntent, confidence: 0.72, source: 'deterministic_fallback', fallbackIntent };
    }
    return { intent: 'none', confidence: 0, source: 'outside_reminder_context', fallbackIntent };
  }

  const parser = typeof parseIntent === 'function' ? parseIntent : tryOpenAIParse;
  const aiResult = await parser(text, {
    mode: 'interview_reminder_intent',
    booking: {
      status: booking.status || null,
      scheduledAt: booking.scheduledAt ? new Date(booking.scheduledAt).toISOString() : null,
      reminderSentAt: booking.reminderSentAt ? new Date(booking.reminderSentAt).toISOString() : null,
      reminderWindowClosed: Boolean(booking.reminderWindowClosed)
    }
  }).catch((error) => ({ used: true, status: 'error', error }));

  const aiMapped = mapAiRecruitmentIntent(aiResult);
  if (APPOINTMENT_ACTION_INTENTS.has(aiMapped.intent) && aiMapped.confidence >= 0.7) {
    return { ...aiMapped, fallbackIntent };
  }

  if (APPOINTMENT_ACTION_INTENTS.has(fallbackIntent)) {
    return { intent: fallbackIntent, confidence: 0.72, source: 'deterministic_fallback', fallbackIntent };
  }

  return { intent: 'none', confidence: 0, source: 'no_match', fallbackIntent };
}

export async function resolveInterviewIntent(options = {}) {
  const classification = await classifyInterviewIntent(options);
  return classification.intent;
}
