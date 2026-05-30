import { tryOpenAIParse } from './aiParser.js';
import { detectInterviewIntent, hasActiveInterviewBooking } from './interviewLifecycle.js';

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

function classifyFromNaturalText(text = '') {
  const n = normalize(text);
  if (!n) return { intent: 'none', confidence: 0, source: 'semantic_local' };

  const asksAlternative = /\b(reagend|reprogram|aplaz|pospon|cambiar|otro horario|otra hora|otro dia|otra fecha|mas tarde|mas temprano|mañana|manana|despues|despu[eé]s|puedo ir luego|puedo ir mas tarde|puedo ir m[aá]s tarde|hay otro|me puede ubicar|me puedes ubicar)\b/.test(n);
  const hasDifficulty = /\b(se me complic|complicado|me queda dificil|me queda d[ií]ficil|inconveniente|no alcanzo|no llego|voy tarde|llego tarde|me demoro|se me presento|se me present[oó]|no puedo en ese horario|no puedo a esa hora)\b/.test(n);
  if (asksAlternative || (hasDifficulty && /\b(puedo|podria|podr[ií]a|ser[aá]|habra|hay|otro|otra|mas tarde|mañana|manana|despues|despu[eé]s)\b/.test(n))) {
    return { intent: 'reschedule_interview', confidence: 0.82, source: 'semantic_local' };
  }

  if (/\b(ya no voy|no voy|no puedo asistir|no puedo ir|no asistire|no asistir[eé]|cancel|cancela|cancelar|cancelo|no me presento|imposible asistir|no estoy disponible)\b/.test(n)) {
    return { intent: 'cancel_interview', confidence: 0.8, source: 'semantic_local' };
  }

  if (/\b(confirmo|confirmada|confirmado|si voy|s[ií] voy|si ire|s[ií] ire|asistire|asistir[eé]|voy en camino|en camino|ya voy|voy saliendo|ya sali|ya sal[ií]|alla estare|all[aá] estare|ahi estare|ah[ií] estare|llego puntual|cuenta conmigo|cuenten conmigo)\b/.test(n)) {
    return { intent: 'confirm_attendance', confidence: 0.8, source: 'semantic_local' };
  }

  if (/^(si|s[ií]|ok|okay|vale|dale|listo|perfecto|claro|voy)$/.test(n)) {
    return { intent: 'confirm_attendance', confidence: 0.76, source: 'semantic_local' };
  }

  if (/\b(direccion|ubicacion|donde queda|hora|documentos|que llevo|a quien pregunto|contacto)\b/.test(n)) {
    return { intent: 'none', confidence: 0.72, source: 'semantic_local_logistics' };
  }

  return { intent: 'none', confidence: 0, source: 'semantic_local' };
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

export async function classifyInterviewIntent({ text = '', booking = null, now = new Date() } = {}) {
  const fallbackIntent = detectInterviewIntent({ text, booking, now });
  if (!hasActiveInterviewBooking(booking)) return { intent: 'none', confidence: 0, source: 'no_active_booking', fallbackIntent };

  const reminderContext = Boolean(booking?.reminderSentAt || booking?.reminderWindowClosed);
  if (!reminderContext && fallbackIntent === 'none') return { intent: 'none', confidence: 0, source: 'outside_reminder_context', fallbackIntent };

  const local = classifyFromNaturalText(text);
  if (APPOINTMENT_ACTION_INTENTS.has(local.intent) && local.confidence >= 0.76) {
    return { ...local, fallbackIntent };
  }

  const aiResult = await tryOpenAIParse(text, {
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

  if (local.source === 'semantic_local_logistics') {
    return { ...local, fallbackIntent };
  }

  return { intent: 'none', confidence: 0, source: 'no_match', fallbackIntent };
}

export async function resolveInterviewIntent(options = {}) {
  const classification = await classifyInterviewIntent(options);
  return classification.intent;
}
