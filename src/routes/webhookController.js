import express from 'express';
import {
  parseWebhookPayload,
  verifySignature
} from '../infrastructure/transport/metaAdapter.js';
import { enqueueInboundMessage } from '../services/jobQueue.js';

export function createWebhookJsonParser() {
  return express.json({
    limit: '2mb',
    verify(req, _res, buffer) {
      req.rawBody = Buffer.from(buffer);
    }
  });
}

export function createMetaVerificationHandler(verifyToken = process.env.META_VERIFY_TOKEN) {
  return function metaVerificationHandler(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (typeof verifyToken === 'string' && verifyToken.length > 0
      && mode === 'subscribe' && token === verifyToken && typeof challenge === 'string') {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  };
}

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

  if (typeof secret !== 'string' || !secret.trim()) {
    try {
      logger?.error?.({ event: 'conversation_webhook.missing_app_secret' },
        'META_APP_SECRET (or WHATSAPP_APP_SECRET) is required for signed webhook requests');
    } catch {
      // Configuration logging must not prevent the admin server from starting.
    }
  }

  return async function webhookController(req, res) {
    if (typeof secret !== 'string' || !secret.trim()) {
      res.sendStatus(503);
      return;
    }
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
