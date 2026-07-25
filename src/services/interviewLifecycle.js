const INTERVIEW_NO_RESPONSE_MINUTES_BEFORE = 5;

const ACTIVE_BOOKING_STATUSES = new Set(['SCHEDULED', 'CONFIRMED']);
const CLOSED_BOOKING_STATUSES = new Set(['CANCELLED', 'RESCHEDULED', 'NO_RESPONSE', 'ATTENDED', 'NO_SHOW']);

function normalize(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
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

export function classifyLocalInterviewIntent(text = '') {
  const n = normalize(text);
  if (!n) {
    return {
      intent: 'none',
      confidence: 0,
      source: 'semantic_local',
      confirmationKind: null
    };
  }

  const asksAlternative = /\b(reagend(?:ar|o|a|emos|ada|ado|amiento)?|reprogram(?:ar|o|a|emos|ada|ado|acion)?|aplaz(?:ar|o|a|amos|ada|ado)?|pospon(?:er|go|es|emos|ida|ido)?|otro horario|otra hora|otro dia|otra fecha|mas tarde|mas temprano|puedo ir luego|puedo ir mas tarde|hay otro|me pasas otra fecha|puede ser manana|podemos cambiar|puedo cambiar|me queda mejor|mover cita|cambiar(?: la)? (?:cita|hora|horario|fecha)|cambiarla|llego tarde|voy tarde|no llego a tiempo)\b/.test(n);
  const hasDifficulty = /\b(se me complic|complicado|me queda dificil|inconveniente|no alcanzo|no llego|voy tarde|llego tarde|me demoro|se me presento|no puedo en ese horario|no puedo a esa hora|no puedo ir)\b/.test(n);
  const hasAlternativeQualifier = /\b(puedo|podria|sera|habra|hay|otro|otra|mas tarde|mas temprano|manana|despues|luego|cambiar|mover)\b/.test(n);

  if (asksAlternative || (hasDifficulty && hasAlternativeQualifier)) {
    return {
      intent: 'reschedule_interview',
      confidence: 0.82,
      source: 'semantic_local',
      confirmationKind: null
    };
  }

  const hasCancellationSignal = /\b(cancel|cancelar|cancelo|cancele|cancelada|cancelado|ya no voy|no voy|no asistire|no puedo asistir|no puedo ir|no podre asistir|no podre ir|no alcanzo|no estoy disponible|no me presento|no puedo presentarme|imposible asistir|se me dificulta asistir|se me complica asistir)\b/.test(n);
  if (hasCancellationSignal) {
    return {
      intent: 'cancel_interview',
      confidence: 0.8,
      source: 'semantic_local',
      confirmationKind: null
    };
  }

  const hasStrongAffirmativeInterviewSignal = /\b(confirmo|confirmada|confirmado|confirmo asistencia|confirmo mi asistencia|te confirmo|si voy|si ire|si asistire|si puedo asistir|voy a asistir|voy para alla|voy en camino|en camino|ya voy|voy saliendo|ya sali|alla estare|ahi estare|estare ahi|estare alla|estare puntual|asistire|me presento|nos vemos|llego puntual|cuenten conmigo|cuenta conmigo)\b/.test(n);
  if (hasStrongAffirmativeInterviewSignal) {
    return {
      intent: 'confirm_attendance',
      confidence: 0.8,
      source: 'semantic_local',
      confirmationKind: 'strong'
    };
  }

  if (/^(si|sii|ok|okay|vale|dale|listo|perfecto|claro|voy)$/.test(n)) {
    return {
      intent: 'confirm_attendance',
      confidence: 0.76,
      source: 'semantic_local',
      confirmationKind: 'short'
    };
  }

  if (/\b(direccion|ubicacion|donde queda|hora|documentos|que llevo|a quien pregunto|contacto)\b/.test(n)) {
    return {
      intent: 'none',
      confidence: 0.72,
      source: 'semantic_local_logistics',
      confirmationKind: null
    };
  }

  return {
    intent: 'none',
    confidence: 0,
    source: 'semantic_local',
    confirmationKind: null
  };
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

  const local = classifyLocalInterviewIntent(text);
  if (local.intent === 'cancel_interview' || local.intent === 'reschedule_interview') {
    return local.intent;
  }
  if (local.intent !== 'confirm_attendance') return 'none';

  const reminderContext = Boolean(booking?.reminderSentAt || booking?.reminderWindowClosed);
  if (local.confirmationKind === 'short') {
    return reminderContext ? 'confirm_attendance' : 'none';
  }

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
