const INTERVIEW_NO_RESPONSE_MINUTES_BEFORE = 5;

const ACTIVE_BOOKING_STATUSES = new Set(['SCHEDULED', 'CONFIRMED']);
const CLOSED_BOOKING_STATUSES = new Set(['CANCELLED', 'RESCHEDULED', 'NO_RESPONSE', 'ATTENDED', 'NO_SHOW']);

function normalize(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function toBogotaDateParts(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function hasActiveInterviewBooking(booking) {
  return Boolean(booking && ACTIVE_BOOKING_STATUSES.has(booking.status));
}

export function shouldStopInterviewAutomation(booking, now = new Date()) {
  if (!booking) return true;
  if (CLOSED_BOOKING_STATUSES.has(booking.status)) return true;
  const scheduledAt = new Date(booking.scheduledAt);
  if (scheduledAt <= now) return true;
  if (booking.reminderSentAt || booking.reminderWindowClosed) return true;
  return false;
}

export function isInterviewSameBogotaDay(booking, now = new Date()) {
  if (!booking?.scheduledAt) return false;
  const scheduledAt = new Date(booking.scheduledAt);
  if (scheduledAt <= now) return false;
  return toBogotaDateParts(scheduledAt) === toBogotaDateParts(now);
}

export function isWithinInterviewConfirmationWindow(booking, now = new Date()) {
  if (!hasActiveInterviewBooking(booking)) return false;
  return isInterviewSameBogotaDay(booking, now);
}

export function detectInterviewIntent({ text = '', booking = null, now = new Date() } = {}) {
  if (!hasActiveInterviewBooking(booking)) return 'none';

  const n = normalize(text)
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return 'none';

  const reminderContext = Boolean(booking?.reminderSentAt || booking?.reminderWindowClosed);

  const hasCancellationSignal = /\b(cancel|cancelar|cancelo|cancele|cancelada|cancelado|ya no voy|no voy|no asistire|no asistir[eé]|no puedo asistir|no puedo ir|no podre asistir|no podr[eé] asistir|no podre ir|no podr[eé] ir|no alcanzo|no estoy disponible|no me presento|no puedo presentarme|imposible asistir|se me dificulta asistir|se me complica asistir)\b/.test(n);
  if (hasCancellationSignal) {
    return 'cancel_interview';
  }

  const hasRescheduleSignal = /\b(reagend|reprogram|aplazar|posponer|otro horario|otra hora|otro dia|otro d[ií]a|otra fecha|cambiar horario|cambiar la cita|cambiarla|mover cita|mas tarde|m[aá]s tarde|mas temprano|m[aá]s temprano|me pasas otra fecha|puede ser manana|puede ser ma[ñn]ana|podemos cambiar|puedo cambiar|me queda mejor|llego tarde|voy tarde|no llego a tiempo)\b/.test(n);
  if (hasRescheduleSignal) {
    return 'reschedule_interview';
  }

  const hasStrongAffirmativeInterviewSignal = /\b(confirmo|confirmada|confirmado|confirmo asistencia|confirmo mi asistencia|te confirmo|si voy|s[ií] voy|si ire|s[ií] ire|si asistire|s[ií] asistire|si puedo asistir|s[ií] puedo asistir|voy a asistir|voy para alla|voy para all[aá]|voy en camino|alla estare|all[aá] estare|ahi estare|ah[ií] estare|estare ahi|estar[eé] ahi|estar[eé] all[aá]|estare puntual|estar[eé] puntual|asistire|asistir[eé]|me presento|nos vemos|cuenten conmigo|cuenta conmigo)\b/.test(n);
  const hasShortReminderAffirmation = reminderContext && /^(si|s[ií]|sii|claro|ok|okay|vale|dale|listo|perfecto|confirmo|confirmada|confirmado|alla estare|all[aá] estare|ahi estare|ah[ií] estare|voy|voy en camino)$/.test(n);
  if (!hasStrongAffirmativeInterviewSignal && !hasShortReminderAffirmation) return 'none';

  if (!reminderContext && !isWithinInterviewConfirmationWindow(booking, now)) return 'none';
  return 'confirm_attendance';
}

export function shouldMarkNoResponse(booking, { now = new Date(), hasReminderReply = false } = {}) {
  if (!hasActiveInterviewBooking(booking)) return false;
  if (!booking?.reminderSentAt) return false;
  if (hasReminderReply) return false;
  if (!isInterviewSameBogotaDay(booking, now)) return false;

  const scheduledAt = new Date(booking.scheduledAt);
  const remainingMinutes = (scheduledAt.getTime() - now.getTime()) / (60 * 1000);

  return remainingMinutes > 0 && remainingMinutes <= INTERVIEW_NO_RESPONSE_MINUTES_BEFORE;
}

export function getInterviewConfirmationWindowHours() {
  return 0;
}

export function getInterviewNoResponseMinutesBefore() {
  return INTERVIEW_NO_RESPONSE_MINUTES_BEFORE;
}
