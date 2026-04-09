const DEFAULT_MULTILINE_WINDOW_MS = 60000;
const MIN_MULTILINE_WINDOW_MS = 12000;
const MAX_MULTILINE_WINDOW_MS = 90000;

function normalizeText(text = '') {
  return String(text || '').trim();
}

function isEarlyConversationContext(context = {}) {
  return !context.vacancyResolved || ['MENU', 'GREETING_SENT'].includes(String(context.currentStep || ''));
}

function looksLikeShortFragment(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (normalized.length > 90) return false;
  return !/[?¿]/.test(normalized);
}

export function getMultilineWindowMs(context = {}) {
  if (process.env.NODE_ENV === 'test') return 0;
  const raw = Number.parseInt(String(process.env.MULTILINE_SILENCE_WINDOW_MS || ''), 10);
  if (Number.isFinite(raw)) {
    return Math.max(MIN_MULTILINE_WINDOW_MS, Math.min(MAX_MULTILINE_WINDOW_MS, raw));
  }

  const adaptiveDefault = isEarlyConversationContext(context) || looksLikeShortFragment(context.text)
    ? DEFAULT_MULTILINE_WINDOW_MS
    : 20000;
  return Math.max(MIN_MULTILINE_WINDOW_MS, Math.min(MAX_MULTILINE_WINDOW_MS, adaptiveDefault));
}

export function summarizeConsolidatedInput(text = '') {
  const collapsed = normalizeText(String(text || '').replace(/\s+/g, ' '));
  if (!collapsed) return null;
  const sanitized = collapsed
    .replace(/\b\d{5,}\b/g, '[doc]')
    .replace(/\b\d{1,2}\s*(a[ñn]os?)\b/gi, '[edad]')
    .replace(/\bedad\s*[:\-]?\s*\d{1,2}\b/gi, '[edad]')
    .replace(/\b(cc|ti|ce|ppt|pasaporte)\b/gi, '[doc_tipo]');
  return sanitized.slice(0, 240);
}

export function consolidateTextMessages(messages = []) {
  return messages
    .map((message) => normalizeText(message.body || ''))
    .filter(Boolean)
    .join('\n');
}
