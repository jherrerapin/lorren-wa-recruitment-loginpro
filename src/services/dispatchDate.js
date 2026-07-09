const COLOMBIA_TIME_ZONE = 'America/Bogota';
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function formatDatePartsInColombia(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: COLOMBIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function addIsoDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function isValidDispatchIsoDate(value) {
  if (!ISO_DATE_PATTERN.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function todayIsoDateCO(now = new Date()) {
  return formatDatePartsInColombia(now);
}

export function normalizeDispatchDateParam(value, fallbackDate = todayIsoDateCO()) {
  const rawValue = normalizeString(value);
  return rawValue && isValidDispatchIsoDate(rawValue) ? rawValue : fallbackDate;
}

export function parseDispatchServiceDate(dateText) {
  const normalizedDate = normalizeDispatchDateParam(dateText);
  // Colombia no maneja horario de verano: UTC-05 es estable para fechas operativas.
  return new Date(`${normalizedDate}T00:00:00-05:00`);
}

export function buildDispatchServiceDateSearchRange(dateText) {
  const normalizedDate = normalizeDispatchDateParam(dateText);
  const nextDate = addIsoDays(normalizedDate, 1);
  return {
    start: new Date(`${normalizedDate}T00:00:00.000Z`),
    end: new Date(`${nextDate}T05:00:00.000Z`)
  };
}

export function dispatchServiceDateKey(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const isLegacyUtcDateOnly = date.getUTCHours() === 0
    && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0;

  if (isLegacyUtcDateOnly) return date.toISOString().slice(0, 10);
  return formatDatePartsInColombia(date);
}

export function filterDispatchServiceRequestsByDate(requests = [], dateText) {
  const normalizedDate = normalizeDispatchDateParam(dateText);
  return requests.filter((request) => dispatchServiceDateKey(request?.serviceDate) === normalizedDate);
}

export function buildDispatchServiceDateWhere(dateText) {
  const { start, end } = buildDispatchServiceDateSearchRange(dateText);
  return { serviceDate: { gte: start, lt: end } };
}
