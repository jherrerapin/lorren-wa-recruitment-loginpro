import crypto from 'node:crypto';
import express from 'express';
import {
  dispatchWhatsappAppSecret,
  dispatchWhatsappVerifyTokens,
  processDispatchWhatsappWebhook,
  resolveDispatchWhatsappScopeByPhoneNumberId
} from '../services/dispatchWhatsappCloudService.js';

function parsePayload(rawBody) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) return null;
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function payloadPhoneNumberIds(payload = {}) {
  const ids = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      const phoneNumberId = String(value?.metadata?.phone_number_id || '').trim();
      if (phoneNumberId) ids.push(phoneNumberId);
    }
  }
  return [...new Set(ids)];
}

export function verifyDispatchWhatsappSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || !appSecret) return false;
  const received = String(signatureHeader || '').trim();
  if (!/^sha256=[a-f0-9]{64}$/i.test(received)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const receivedBuffer = Buffer.from(received, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function resolveWebhookScopes(payload) {
  return [...new Set(payloadPhoneNumberIds(payload)
    .map((phoneNumberId) => resolveDispatchWhatsappScopeByPhoneNumberId(phoneNumberId))
    .filter(Boolean))];
}

export function dispatchWhatsappWebhookRouter(prisma) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');
    const acceptedTokens = new Set(dispatchWhatsappVerifyTokens());
    if (mode === 'subscribe' && token && acceptedTokens.has(token)) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res, next) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      const payload = parsePayload(rawBody);
      if (!payload) return res.sendStatus(400);

      const scopes = resolveWebhookScopes(payload);
      if (!scopes.length) return res.sendStatus(200);

      const signature = req.get('x-hub-signature-256');
      const signatureValid = scopes.some((scope) => verifyDispatchWhatsappSignature(
        rawBody,
        signature,
        dispatchWhatsappAppSecret(scope)
      ));
      if (!signatureValid) {
        console.warn(`[dispatch-wa-cloud] Firma de webhook inválida. scopes=${scopes.join(',')}.`);
        return res.sendStatus(401);
      }

      await processDispatchWhatsappWebhook(payload, { prismaClient: prisma });
      return res.sendStatus(200);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
