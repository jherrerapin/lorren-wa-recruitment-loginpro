import crypto from 'node:crypto';

const DEFAULT_DAILY_BUDGET = 2_500_000;
const USAGE_ENTITY_TYPE = 'LORREN_AI_USAGE';
const TICKET_DEVELOPMENT_ACTION = 'TICKET_DEVELOPMENT_USAGE';

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
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function addUsage(target, usage = {}) {
  target.inputTokens += number(usage.inputTokens ?? usage.input_tokens);
  target.cachedInputTokens += number(usage.cachedInputTokens ?? usage.cached_input_tokens);
  target.outputTokens += number(usage.outputTokens ?? usage.output_tokens);
  target.reasoningTokens += number(usage.reasoningTokens ?? usage.reasoning_tokens ?? usage.reasoning_output_tokens);
  target.totalTokens += number(usage.totalTokens ?? usage.total_tokens);
  target.events += 1;
  return target;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    events: 0
  };
}

function usageFromDebugTrace(message) {
  const trace = message?.rawPayload?.debugTrace;
  if (!trace || typeof trace !== 'object') return null;
  const totalTokens = number(trace.openai_total_tokens ?? trace.model_usage?.total_tokens);
  if (!totalTokens) return null;
  return {
    inputTokens: number(trace.openai_input_tokens ?? trace.model_usage?.input_tokens),
    outputTokens: number(trace.openai_output_tokens ?? trace.model_usage?.output_tokens),
    totalTokens
  };
}

function usageFromCvRow(row) {
  const totalTokens = number(row?.totalTokens);
  if (!totalTokens) return null;
  return {
    inputTokens: number(row?.inputTokens),
    cachedInputTokens: number(row?.cachedInputTokens),
    outputTokens: number(row?.outputTokens),
    reasoningTokens: number(row?.reasoningTokens),
    totalTokens
  };
}

function usageFromTicketAudit(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const totalTokens = number(metadata.totalTokens);
  if (!totalTokens) return null;
  return {
    inputTokens: number(metadata.inputTokens),
    cachedInputTokens: number(metadata.cachedInputTokens),
    outputTokens: number(metadata.outputTokens),
    reasoningTokens: number(metadata.reasoningTokens),
    totalTokens
  };
}

async function loadBotUsage(prisma, range) {
  if (!prisma?.message?.findMany) return { usage: emptyUsage(), observable: false };
  const rows = await prisma.message.findMany({
    where: { createdAt: { gte: range.start, lt: range.end } },
    select: { rawPayload: true }
  });
  const usage = emptyUsage();
  for (const row of rows) {
    const observed = usageFromDebugTrace(row);
    if (observed) addUsage(usage, observed);
  }
  return { usage, observable: true };
}

async function loadCvUsage(prisma, range) {
  if (!prisma?.cvAnalysisUsage?.findMany) return { usage: emptyUsage(), observable: false };
  const rows = await prisma.cvAnalysisUsage.findMany({
    where: { createdAt: { gte: range.start, lt: range.end } },
    select: {
      inputTokens: true,
      cachedInputTokens: true,
      outputTokens: true,
      reasoningTokens: true,
      totalTokens: true
    }
  });
  const usage = emptyUsage();
  for (const row of rows) {
    const observed = usageFromCvRow(row);
    if (observed) addUsage(usage, observed);
  }
  return { usage, observable: true };
}

async function loadTicketDevelopmentUsage(prisma, range) {
  if (!prisma?.devAuditEvent?.findMany) return { usage: emptyUsage(), observable: false };
  const rows = await prisma.devAuditEvent.findMany({
    where: {
      entityType: USAGE_ENTITY_TYPE,
      action: TICKET_DEVELOPMENT_ACTION,
      createdAt: { gte: range.start, lt: range.end }
    },
    select: { metadata: true }
  });
  const usage = emptyUsage();
  for (const row of rows) {
    const observed = usageFromTicketAudit(row);
    if (observed) addUsage(usage, observed);
  }
  return { usage, observable: true };
}

export async function loadLorrenAiUsageSummary(prisma, options = {}) {
  const now = options.now || new Date();
  const env = options.env || process.env;
  const range = utcDayRange(now);
  const [bot, cv, ticketDevelopment] = await Promise.all([
    loadBotUsage(prisma, range),
    loadCvUsage(prisma, range),
    loadTicketDevelopmentUsage(prisma, range)
  ]);

  const totalTokens = bot.usage.totalTokens + cv.usage.totalTokens + ticketDevelopment.usage.totalTokens;
  const budget = dailyBudget(env);
  return {
    period: { start: range.start.toISOString(), end: range.end.toISOString(), timeZone: 'UTC' },
    bot: bot.usage,
    cv: cv.usage,
    ticketDevelopment: ticketDevelopment.usage,
    totalTokens,
    dailyBudget: budget,
    remainingTokens: Math.max(0, budget - totalTokens),
    coverage: {
      bot: bot.observable,
      cv: cv.observable,
      ticketDevelopment: ticketDevelopment.observable
    }
  };
}

function usageSigningKey(token) {
  return crypto.createHash('sha256').update(`lorren-ticket-usage:${token}`).digest();
}

export function signLorrenTicketDevelopmentUsage(rawBody, token) {
  const secret = String(token || '').trim();
  if (!secret) throw new Error('lorren_ai_usage_signing_secret_missing');
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  return crypto.createHmac('sha256', usageSigningKey(secret)).update(body).digest('hex');
}

export function verifyLorrenTicketDevelopmentUsageSignature(rawBody, signature, env = process.env) {
  const token = String(env.LORREN_SUPPORT_GITHUB_TOKEN || '').trim();
  const supplied = String(signature || '').trim().replace(/^sha256=/i, '');
  if (!token || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = signLorrenTicketDevelopmentUsage(rawBody, token);
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(supplied, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function recordLorrenTicketDevelopmentUsage(prisma, input = {}) {
  if (!verifyLorrenTicketDevelopmentUsageSignature(input.rawBody, input.signature, input.env || process.env)) {
    throw new Error('lorren_ai_usage_signature_invalid');
  }
  if (!prisma?.devAuditEvent?.findFirst || !prisma?.devAuditEvent?.create) {
    throw new Error('lorren_ai_usage_persistence_unavailable');
  }

  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const dispatchId = String(payload.dispatch_id || '').trim().slice(0, 160);
  const publicCode = String(payload.public_code || '').trim().slice(0, 80);
  if (!dispatchId || !publicCode) throw new Error('lorren_ai_usage_payload_invalid');

  const usage = {
    inputTokens: number(payload.input_tokens),
    cachedInputTokens: number(payload.cached_input_tokens),
    outputTokens: number(payload.output_tokens),
    reasoningTokens: number(payload.reasoning_tokens),
    totalTokens: number(payload.total_tokens)
  };
  if (!usage.totalTokens) return { ok: true, ignored: true, duplicate: false };

  const existing = await prisma.devAuditEvent.findFirst({
    where: {
      entityType: USAGE_ENTITY_TYPE,
      entityId: dispatchId,
      action: TICKET_DEVELOPMENT_ACTION
    },
    select: { id: true }
  });
  if (existing) return { ok: true, ignored: false, duplicate: true };

  await prisma.devAuditEvent.create({
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
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens
      }
    }
  });
  return { ok: true, ignored: false, duplicate: false };
}

export const LORREN_AI_USAGE_DEFAULT_DAILY_BUDGET = DEFAULT_DAILY_BUDGET;
