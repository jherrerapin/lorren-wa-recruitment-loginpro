import crypto from 'node:crypto';
import axios from 'axios';

const DEFAULT_REPOSITORY = 'jherrerapin/lorren-wa-recruitment-loginpro';
const EVENT_TYPE = 'lorren_support_ticket_approved';
const GITHUB_API = 'https://api.github.com';
const DISPATCH_ENTITY_TYPE = 'LORREN_SUPPORT_DEVELOPMENT_DISPATCH';
const DISPATCH_ACTION = 'LORREN_SUPPORT_DEVELOPMENT_DISPATCHED';

function text(value, max = 6000) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : null;
}

function repositoryName(value) {
  const candidate = text(value, 220) || DEFAULT_REPOSITORY;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate) ? candidate : null;
}

function publicOrigin(env = process.env) {
  const explicit = text(env.LORREN_PUBLIC_ORIGIN, 500);
  const railwayDomain = text(env.RAILWAY_PUBLIC_DOMAIN, 300);
  const candidate = explicit || (railwayDomain ? `https://${railwayDomain}` : null);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function stableDispatchId(ticket) {
  const source = `${ticket?.id || ''}:${ticket?.developmentRequestedAt || ''}`;
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 24);
}

export function getLorrenSupportDevelopmentConfig(env = process.env) {
  const origin = publicOrigin(env);
  return {
    token: text(env.LORREN_SUPPORT_GITHUB_TOKEN, 1000),
    repository: repositoryName(env.LORREN_SUPPORT_GITHUB_REPOSITORY),
    eventType: EVENT_TYPE,
    usageCallbackUrl: origin ? `${origin}/admin/lorren-tickets/internal/development-usage` : null
  };
}

export function lorrenSupportDevelopmentReadiness(env = process.env) {
  const config = getLorrenSupportDevelopmentConfig(env);
  const missing = [];
  if (!config.token) missing.push('LORREN_SUPPORT_GITHUB_TOKEN');
  if (!config.repository) missing.push('LORREN_SUPPORT_GITHUB_REPOSITORY');
  return { ready: missing.length === 0, missing, repository: config.repository, eventType: config.eventType };
}

function interpretationPayload(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    title: text(source.title, 220),
    module: text(source.module, 80),
    type: text(source.type, 80),
    summary: text(source.summary, 2000),
    currentBehavior: text(source.currentBehavior, 1600),
    expectedBehavior: text(source.expectedBehavior, 1600),
    suggestedScope: text(source.suggestedScope, 2000),
    confidence: text(source.confidence, 40),
    suggestedPriority: text(source.suggestedPriority, 40)
  };
}

export async function loadLorrenSupportDevelopmentDispatch(prisma, ticketId) {
  if (!ticketId || !prisma?.devAuditEvent?.findFirst) return null;
  const row = await prisma.devAuditEvent.findFirst({
    where: { entityType: DISPATCH_ENTITY_TYPE, entityId: ticketId, action: DISPATCH_ACTION },
    orderBy: { createdAt: 'desc' }
  });
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : null;
  return metadata ? { ...metadata, auditEventId: row.id, auditCreatedAt: row.createdAt } : null;
}

async function persistDispatch(prisma, ticket, result, actor = {}) {
  if (!prisma?.devAuditEvent?.create) return;
  const dispatchedAt = new Date().toISOString();
  const metadata = {
    ticketId: ticket.id,
    publicCode: ticket.publicCode,
    dispatchId: result.dispatchId,
    repository: result.repository,
    dispatchedAt
  };
  await prisma.devAuditEvent.create({
    data: {
      entityType: DISPATCH_ENTITY_TYPE,
      entityId: ticket.id,
      entityLabel: ticket.publicCode,
      action: DISPATCH_ACTION,
      actorUserId: text(actor.actorUserId, 160),
      actorUsername: text(actor.actorUsername, 160),
      actorRole: text(actor.actorRole, 80),
      actorSource: text(actor.actorSource, 120) || 'lorren-support-development-dispatch',
      metadata
    }
  });
  return metadata;
}

export async function dispatchLorrenSupportDevelopment(prisma, ticket, options = {}) {
  if (!ticket?.id || !ticket?.publicCode || !ticket?.originalText) {
    throw new Error('lorren_support_development_ticket_invalid');
  }

  const existing = await loadLorrenSupportDevelopmentDispatch(prisma, ticket.id);
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      dispatchId: existing.dispatchId,
      repository: existing.repository,
      dispatchedAt: existing.dispatchedAt
    };
  }

  const env = options.env || process.env;
  const config = getLorrenSupportDevelopmentConfig(env);
  const readiness = lorrenSupportDevelopmentReadiness(env);
  if (!readiness.ready) return { ok: false, reason: 'not_configured', missing: readiness.missing };

  const dispatchId = stableDispatchId(ticket);
  const axiosClient = options.axiosClient || axios;
  const payload = {
    event_type: config.eventType,
    client_payload: {
      schema_version: 1,
      dispatch_id: dispatchId,
      ticket_id: String(ticket.id).slice(0, 160),
      public_code: String(ticket.publicCode).slice(0, 80),
      priority: text(ticket.priority, 40) || 'NORMAL',
      original_text: String(ticket.originalText).slice(0, 6000),
      interpretation: interpretationPayload(ticket.interpretation),
      approved_at: text(ticket.developmentRequestedAt, 80),
      approved_by: text(ticket.developmentRequestedBy, 160),
      usage_callback_url: config.usageCallbackUrl
    }
  };

  await axiosClient.post(`${GITHUB_API}/repos/${config.repository}/dispatches`, payload, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'lorren-support-development-dispatch'
    },
    timeout: 12000,
    maxContentLength: 256 * 1024,
    maxBodyLength: 256 * 1024
  });

  const metadata = await persistDispatch(prisma, ticket, { dispatchId, repository: config.repository }, options.actor || {});
  return {
    ok: true,
    duplicate: false,
    dispatchId,
    repository: config.repository,
    dispatchedAt: metadata?.dispatchedAt || null
  };
}
