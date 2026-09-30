import {
  parseWebhookPayload,
  verifySignature
} from '../infrastructure/transport/metaAdapter.js';
import { enqueueInboundMessage } from '../services/jobQueue.js';

function signatureHeader(req) {
  if (typeof req?.get === 'function') return req.get('x-hub-signature-256');
  return req?.headers?.['x-hub-signature-256'];
}

function rawRequestBody(req) {
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req?.body)) return req.body;
  return null;
}

function parsedRequestBody(req) {
  if (!Buffer.isBuffer(req?.body)) return req?.body;
  try {
    return JSON.parse(req.body.toString('utf8'));
  } catch {
    return null;
  }
}

function safeLog(logger, error, messageId) {
  try {
    logger?.error?.({
      event: 'conversation_webhook.enqueue_error',
      messageId,
      error: error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'UnknownError', message: String(error) }
    }, 'Conversation webhook enqueue failed');
  } catch {
    // Observability must never create a second unhandled failure.
  }
}

/**
 * Build the definitive Meta webhook controller. Express must preserve the raw
 * request bytes in `req.rawBody` (or provide a Buffer as `req.body`) before any
 * JSON parser mutates them.
 */
export function createWebhookController(dependencies = {}, overrides = {}) {
  const prisma = dependencies.prisma;
  const logger = dependencies.logger ?? console;
  const secret = dependencies.secret
    ?? process.env.WHATSAPP_APP_SECRET
    ?? process.env.META_APP_SECRET;

  const verify = overrides.verifySignature ?? verifySignature;
  const parse = overrides.parseWebhookPayload ?? parseWebhookPayload;
  const enqueue = overrides.enqueueInboundMessage ?? enqueueInboundMessage;

  return async function webhookController(req, res) {
    const rawBody = rawRequestBody(req);
    const signature = signatureHeader(req);

    if (!verify(rawBody, signature, secret)) {
      res.sendStatus(401);
      return;
    }

    const payload = parse(parsedRequestBody(req));
    if (!payload) {
      res.sendStatus(200);
      return;
    }

    try {
      // Never acknowledge an actionable message until PostgreSQL owns it.
      await enqueue(payload, { prisma });
      res.sendStatus(200);
    } catch (error) {
      safeLog(logger, error, payload.messageId);
      res.sendStatus(500);
    }
  };
}

export default createWebhookController;
