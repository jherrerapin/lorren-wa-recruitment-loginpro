import crypto from 'node:crypto';
import axios from 'axios';

const DEFAULT_REPOSITORY = 'jherrerapin/lorren-wa-recruitment-loginpro';
const EVENT_TYPE = 'lorren_support_ticket_approved';
const GITHUB_API = 'https://api.github.com';

function text(value, max = 6000) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : null;
}

function repositoryName(value) {
  const candidate = text(value, 220) || DEFAULT_REPOSITORY;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate) ? candidate : null;
}

export function getLorrenSupportDevelopmentConfig(env = process.env) {
  return {
    token: text(env.LORREN_SUPPORT_GITHUB_TOKEN, 1000),
    repository: repositoryName(env.LORREN_SUPPORT_GITHUB_REPOSITORY),
    eventType: EVENT_TYPE
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

export async function dispatchLorrenSupportDevelopment(ticket, options = {}) {
  if (!ticket?.id || !ticket?.publicCode || !ticket?.originalText) {
    throw new Error('lorren_support_development_ticket_invalid');
  }
  if (ticket.developmentDispatchId) {
    return {
      ok: true,
      duplicate: true,
      dispatchId: ticket.developmentDispatchId,
      repository: ticket.developmentRepository || null
    };
  }

  const env = options.env || process.env;
  const config = getLorrenSupportDevelopmentConfig(env);
  const readiness = lorrenSupportDevelopmentReadiness(env);
  if (!readiness.ready) return { ok: false, reason: 'not_configured', missing: readiness.missing };

  const dispatchId = crypto.randomUUID();
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
      approved_by: text(ticket.developmentRequestedBy, 160)
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

  return { ok: true, duplicate: false, dispatchId, repository: config.repository };
}
