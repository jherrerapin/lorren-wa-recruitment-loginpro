const DEFAULT_MULTILINE_WINDOW_MS = 10000;
const MIN_MULTILINE_WINDOW_MS = 8000;
const MAX_MULTILINE_WINDOW_MS = 12000;

function normalizeText(text = '') {
  return String(text || '').trim();
}

export function getMultilineWindowMs() {
  const raw = Number.parseInt(String(process.env.MULTILINE_SILENCE_WINDOW_MS || DEFAULT_MULTILINE_WINDOW_MS), 10);
  if (!Number.isFinite(raw)) return DEFAULT_MULTILINE_WINDOW_MS;
  return Math.max(MIN_MULTILINE_WINDOW_MS, Math.min(MAX_MULTILINE_WINDOW_MS, raw));
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
