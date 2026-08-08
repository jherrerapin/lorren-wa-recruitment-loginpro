import { buildAdContextSystemHint } from './adContext.js';

const DEFAULT_REASONING_WINDOW_MS = 8000;
const MIN_REASONING_WINDOW_MS = 3000;
const MAX_REASONING_WINDOW_MS = 20000;

function normalizeText(text = '') {
  return String(text || '').trim();
}

function getMessageAdContext(message = {}) {
  return message?.rawPayload?.lorrenAdContext
    || message?.lorrenAdContext
    || null;
}

function buildAdContextHintFromMessages(messages = []) {
  const contexts = messages
    .map(getMessageAdContext)
    .filter((context) => context?.text)
    .filter((context, index, list) => list.findIndex((item) => item.text === context.text) === index);

  if (!contexts.length) return '';

  return contexts
    .map(buildAdContextSystemHint)
    .filter(Boolean)
    .join('\n');
}

export function getMultilineWindowMs() {
  if (process.env.NODE_ENV === 'test') return 0;
  const raw = Number.parseInt(String(process.env.LORREN_REASONING_WINDOW_MS || process.env.MULTILINE_SILENCE_WINDOW_MS || ''), 10);
  if (Number.isFinite(raw)) {
    return Math.max(MIN_REASONING_WINDOW_MS, Math.min(MAX_REASONING_WINDOW_MS, raw));
  }

  return DEFAULT_REASONING_WINDOW_MS;
}

export function summarizeConsolidatedInput(text = '') {
  const collapsed = normalizeText(String(text || '').replace(/\s+/g, ' '));
  if (!collapsed) return null;
  const sanitized = collapsed
    .replace(/Pista interna de origen Meta Ads[^\n]+/gi, '[contexto_meta_ads]')
    .replace(/\b\d{5,}\b/g, '[doc]')
    .replace(/\b\d{1,2}\s*(a[ñn]os?)\b/gi, '[edad]')
    .replace(/\bedad\s*[:\-]?\s*\d{1,2}\b/gi, '[edad]')
    .replace(/\b(cc|ti|ce|ppt|pasaporte)\b/gi, '[doc_tipo]');
  return sanitized.slice(0, 240);
}

export function consolidateTextMessages(messages = []) {
  const adContextHint = buildAdContextHintFromMessages(messages);
  const candidateText = messages
    .map((message) => normalizeText(message.body || ''))
    .filter(Boolean)
    .join('\n');

  return [adContextHint, candidateText]
    .filter(Boolean)
    .join('\n');
}
