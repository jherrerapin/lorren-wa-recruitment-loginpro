import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const DEFAULT_DAILY_BUDGET = 2_500_000;
const USAGE_ENTITY_TYPE = 'LORREN_AI_USAGE';
const BOT_RUNTIME_ACTION = 'BOT_RUNTIME_USAGE';
const TICKET_DEVELOPMENT_ACTION = 'TICKET_DEVELOPMENT_USAGE';
const usageRecorderStorage = new AsyncLocalStorage();

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function dailyBudget(env = process.env) {
  const configured = Number(env.OPENAI_SHARED_DAILY_TOKEN_BUDGET || 0);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_DAILY_BUDGET;
}

function utcDayRange(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) throw new Error('lorren_ai_usage_invalid_date');
  const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(), 0, 0, 0, 0));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function emptyUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, events: 0 };
}

function normalizeUsage(usage = {}) {
  const inputTokens = number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens);
  const cachedInputTokens = number(usage.cachedInputTokens ?? usage.cached_input_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const outputTokens = number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens);
  const reasoningTokens = number(usage.reasoningTokens ?? usage.reasoning_tokens ?? usage.reasoning_output_tokens ?? usage.completion_tokens_details?.reasoning_tokens);
  const totalTokens = number(usage.totalTokens ?? usage.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens };
}

function addUsage(target, usage = {}) {
  const normalized = normalizeUsage(usage);
  target.inputTokens += normalized.inputTokens;
  target.cachedInputTokens += normalized.cachedInputTokens;
  target.outputTokens += normalized.outputTokens;
  target.reasoningTokens += normalized.reasoningTokens;
  target.totalTokens += normalized.totalTokens;
  target.events += 1;
  return target;
}

function usageFromAudit(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const usage = normalizeUsage(metadata);
  return usage.totalTokens ? usage : null;
}

async function loadAuditUsage(prisma, range, action) {
  if (!prisma?.devAuditEvent?.findMany) return { usage: emptyUsage(), observable: false };
  const rows = await prisma.devAuditEvent.findMany({
    where: { entityType: USAGE_ENTITY_TYPE, action, createdAt: { gte: range.start, lt: range.end } },
    select: { metadata: true }
  });
  const usage = emptyUsage();
  for (const row of rows) {
    const observed = usageFromAudit(row);
    if (observed) addUsage(usage, observed);
  }
  return { usage, observable: true };
}

async function loadCvUsage(prisma, range) {
  if (!prisma?.cvAnalysisUsage?.findMany) return { usage: emptyUsage(), observable: false };
  const rows = await prisma.cvAnalysisUsage.findMany({
    where: { createdAt: { gte: range.start, lt: range.end } },
    select: { inputTokens: true, cachedInputTokens: true, outputTokens: true, reasoningTokens: true, totalTokens: true }
  });
  const usage = emptyUsage();
  for (const row of rows) addUsage(usage, row);
  return { usage, observable: true };
}

export async function loadLorrenAiUsageSummary(prisma, options = {}) {
  const range = utcDayRange(options.now || new Date());
  const [bot, cv, ticketDevelopment] = await Promise.all([
    loadAuditUsage(prisma, range, BOT_RUNTIME_ACTION),
    loadCvUsage(prisma, range),
    loadAuditUsage(prisma, range, TICKET_DEVELOPMENT_ACTION)
  ]);
  const totalTokens = bot.usage.totalTokens + cv.usage.totalTokens + ticketDevelopment.usage.totalTokens;
  const budget = dailyBudget(options.env || process.env);
  return {
    period: { start: range.start.toISOString(), end: range.end.toISOString(), timeZone: 'UTC' },
    bot: bot.usage,
    cv: cv.usage,
    ticketDevelopment: ticketDevelopment.usage,
    totalTokens,
    dailyBudget: budget,
    remainingTokens: Math.max(0, budget - totalTokens),
    coverage: { bot: bot.observable, cv: cv.observable, ticketDevelopment: ticketDevelopment.observable }
  };
}

export function runWithLorrenAiUsageRecorder(recorder, callback) {
  if (typeof callback !== 'function') throw new TypeError('lorren_ai_usage_callback_required');
  return usageRecorderStorage.run(typeof recorder === 'function' ? recorder : null, callback);
}

export async function recordCurrentLorrenBotUsage(event = {}) {
  const recorder = usageRecorderStorage.getStore();
  if (typeof recorder !== 'function') return { recorded: false, reason: 'no_recorder' };
  try {
    await recorder(event);
    return { recorded: true };
  } catch {
    return { recorded: false, reason: 'persistence_failed' };
  }
}

export async function persistLorrenBotUsage(prisma, event = {}) {
  if (!prisma?.devAuditEvent?.create) return { recorded: false, reason: 'persistence_unavailable' };
  const usage = normalizeUsage(event.usage);
  if (!usage.totalTokens) return { recorded: false, reason: 'usage_missing' };
  const source = String(event.source || 'BOT').trim().slice(0, 80) || 'BOT';
  const model = String(event.model || '').trim().slice(0, 120) || null;
  await prisma.devAuditEvent.create({
    data: {
      entityType: USAGE_ENTITY_TYPE,
      entityId: crypto.randomUUID(),
      entityLabel: source,
      action: BOT_RUNTIME_ACTION,
      actorSource: 'lorren-bot-runtime',
      metadata: { source, model, ...usage }
    }
  });
  return { recorded: true };
}

function usageSigningKey(token) {
  return crypto.createHash('sha256').update(`lorren-ticket-usage:${token}`).digest();
}

function canonicalTicketUsageBody(value) {
  let payload = value;
  if (Buffer.isBuffer(payload)) payload = payload.toString('utf8');
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  payload = payload && typeof payload === 'object' ? payload : {};
  return JSON.stringify({
    schema_version: number(payload.schema_version),
    dispatch_id: String(payload.dispatch_id || ''),
    public_code: String(payload.public_code || ''),
    run_id: String(payload.run_id || ''),
    input_tokens: number(payload.input_tokens),
    cached_input_tokens: number(payload.cached_input_tokens),
    output_tokens: number(payload.output_tokens),
    reasoning_tokens: number(payload.reasoning_tokens),
    total_tokens: number(payload.total_tokens)
  });
}

export function signLorrenTicketDevelopmentUsage(payload, token) {
  const secret = String(token || '').trim();
  if (!secret) throw new Error('lorren_ai_usage_signing_secret_missing');
  return crypto.createHmac('sha256', usageSigningKey(secret)).update(canonicalTicketUsageBody(payload)).digest('hex');
}

export function verifyLorrenTicketDevelopmentUsageSignature(payload, signature, env = process.env) {
  const token = String(env.LORREN_SUPPORT_GITHUB_TOKEN || '').trim();
  const supplied = String(signature || '').trim().replace(/^sha256=/i, '');
  if (!token || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = signLorrenTicketDevelopmentUsage(payload, token);
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(supplied, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function persistTicketUsageTransaction(client, dispatchId, publicCode, payload, usage) {
  const existing = await client.devAuditEvent.findFirst({
    where: { entityType: USAGE_ENTITY_TYPE, entityId: dispatchId, action: TICKET_DEVELOPMENT_ACTION },
    select: { id: true }
  });
  if (existing) return { ok: true, ignored: false, duplicate: true };
  await client.devAuditEvent.create({
    data: {
      entityType: USAGE_ENTITY_TYPE,
      entityId: dispatchId,
      entityLabel: publicCode,
      action: TICKET_DEVELOPMENT_ACTION,
      actorSource: 'github-actions-codex-usage',
      metadata: {
        schemaVersion: 1,
        dispatchId,
        publicCode,
        runId: String(payload.run_id || '').trim().slice(0, 120) || null,
        ...usage
      }
    }
  });
  return { ok: true, ignored: false, duplicate: false };
}

async function persistTicketUsageAtomically(prisma, dispatchId, publicCode, payload, usage) {
  if (typeof prisma?.$transaction !== 'function') {
    return persistTicketUsageTransaction(prisma, dispatchId, publicCode, payload, usage);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => persistTicketUsageTransaction(tx, dispatchId, publicCode, payload, usage),
        { isolationLevel: 'Serializable' }
      );
    } catch (error) {
      if (error?.code !== 'P2034' || attempt === 2) throw error;
    }
  }
  throw new Error('lorren_ai_usage_transaction_retry_exhausted');
}

export async function recordLorrenTicketDevelopmentUsage(prisma, input = {}) {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  if (!verifyLorrenTicketDevelopmentUsageSignature(payload, input.signature, input.env || process.env)) {
    throw new Error('lorren_ai_usage_signature_invalid');
  }
  if (!prisma?.devAuditEvent?.findFirst || !prisma?.devAuditEvent?.create) {
    throw new Error('lorren_ai_usage_persistence_unavailable');
  }
  const dispatchId = String(payload.dispatch_id || '').trim().slice(0, 160);
  const publicCode = String(payload.public_code || '').trim().slice(0, 80);
  if (!dispatchId || !publicCode) throw new Error('lorren_ai_usage_payload_invalid');
  const usage = normalizeUsage({
    input_tokens: payload.input_tokens,
    cached_input_tokens: payload.cached_input_tokens,
    output_tokens: payload.output_tokens,
    reasoning_tokens: payload.reasoning_tokens,
    total_tokens: payload.total_tokens
  });
  if (!usage.totalTokens) return { ok: true, ignored: true, duplicate: false };
  return persistTicketUsageAtomically(prisma, dispatchId, publicCode, payload, usage);
}

export const LORREN_AI_USAGE_DEFAULT_DAILY_BUDGET = DEFAULT_DAILY_BUDGET;
