const DEFAULT_TIMEZONE = 'America/Bogota';
const NO_AVAILABILITY_REPLY = 'En este momento no tengo horarios disponibles para ofrecerte. El equipo de selección te contactará por este medio cuando haya disponibilidad.';

function normalizeTimezone(value) {
  const timezone = String(value || '').trim() || DEFAULT_TIMEZONE;

  try {
    // Validates the IANA zone without introducing external state or I/O.
    new Intl.DateTimeFormat('es-CO', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function resolveSlotDate(slot = {}) {
  const raw = slot?.startsAt ?? slot?.date ?? slot?.scheduledAt ?? null;
  if (!raw) return null;

  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatSlotDate(date, timezone) {
  const formatter = new Intl.DateTimeFormat('es-CO', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  return formatter
    .format(date)
    .replace(/\ba\.\s*m\.\b/gi, 'a. m.')
    .replace(/\bp\.\s*m\.\b/gi, 'p. m.');
}

/**
 * Pure presentation function for interview availability.
 *
 * Accepted slot shapes intentionally cover the canonical scheduler projection
 * (`date`) and the Functional Core scheduling contract (`startsAt`). Invalid
 * entries are ignored instead of leaking transport/database concerns here.
 *
 * @param {Array<object>} slots Available slots already resolved by the shell.
 * @param {string} timezone IANA timezone used only for presentation.
 * @returns {string}
 */
export function buildSlotSuggestionReply(slots = [], timezone = DEFAULT_TIMEZONE) {
  const safeSlots = Array.isArray(slots) ? slots : [];
  const zone = normalizeTimezone(timezone);

  const formattedSlots = safeSlots
    .map(resolveSlotDate)
    .filter(Boolean)
    .map((date) => formatSlotDate(date, zone));

  if (!formattedSlots.length) {
    return NO_AVAILABILITY_REPLY;
  }

  const options = formattedSlots
    .map((label, index) => `${index + 1}. ${label}`)
    .join('\n');

  return `Tengo estos horarios disponibles para tu entrevista:\n${options}\n\nRespóndeme con el número del horario que prefieres.`;
}

export default buildSlotSuggestionReply;
