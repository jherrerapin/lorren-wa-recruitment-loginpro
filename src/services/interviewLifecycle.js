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

  const n = normalize(text);
  if (!n) return 'none';

  if (/\b(cancel|cancelar|cancelo|ya no voy|no voy|no podre asistir|no podre ir)\b/.test(n)) {
    return isInterviewSameBogotaDay(booking, now) ? 'cancel_interview' : 'none';
  }

  if (/\b(reagend|reprogram|otro horario|otra hora|otro dia|cambiar horario|mover cita|me pasas otra fecha)\b/.test(n)) {
    return isInterviewSameBogotaDay(booking, now) ? 'reschedule_interview' : 'none';
  }

  const hasAffirmativeInterviewSignal = /\b(confirmo|si voy|si ire|alla estare|estare ahi|asistire|nos vemos|confirmada)\b/.test(n);
  if (!hasAffirmativeInterviewSignal) return 'none';

  if (!isWithinInterviewConfirmationWindow(booking, now)) return 'none';
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
