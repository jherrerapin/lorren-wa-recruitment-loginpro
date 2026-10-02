import crypto from 'node:crypto';
import express from 'express';
import { lorrenWebhookVerification, getLorrenWhatsappConfig } from '../services/lorrenWhatsappClient.js';
import { resolveLorrenAttendanceApproval } from '../services/lorrenBillingWorkflow.js';
import { createLorrenSupportTicketFromWhatsapp } from '../services/lorrenSupportTickets.js';

const DECISION_PATTERN = /^lorren_billing:(approve|reject):(ASIS-\d{6})$/i;

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function verifiedPayload(req, config) {
  if (!Buffer.isBuffer(req.body) || !config.appSecret) return null;
  const header = String(req.get('x-hub-signature-256') || '');
  const expected = `sha256=${crypto.createHmac('sha256', config.appSecret).update(req.body).digest('hex')}`;
  if (!secureEqual(header, expected)) return null;
  try { return JSON.parse(req.body.toString('utf8')); } catch (_error) { return null; }
}
function inboundMessages(body = {}, phoneNumberId) {
  const messages = [];
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (String(change?.value?.metadata?.phone_number_id || '') !== String(phoneNumberId || '')) continue;
      for (const message of Array.isArray(change?.value?.messages) ? change.value.messages : []) messages.push(message);
    }
  }
  return messages;
}
function replyPayload(message = {}) { return message?.interactive?.button_reply?.id || message?.button?.payload || null; }
function plainText(message = {}) { return message?.type === 'text' && typeof message?.text?.body === 'string' ? message.text.body.trim() : ''; }

async function handleBillingDecision(prisma, message) {
  const match = DECISION_PATTERN.exec(String(replyPayload(message) || '').trim());
  if (!match) return false;
  try {
    await resolveLorrenAttendanceApproval(prisma, {
      invoiceNumber: match[2].toUpperCase(),
      decision: match[1].toLowerCase() === 'approve' ? 'APPROVE' : 'REJECT',
      supervisorPhone: message.from || null
    });
  } catch (error) {
    console.error('[LORREN_BILLING_WEBHOOK_FAILED]', { invoiceNumber: match[2], code: error?.message || 'unknown' });
  }
  return true;
}

async function handleSilentSupportTicket(prisma, message) {
  const text = plainText(message);
  if (!text || !message?.id || !message?.from) return;
  try {
    await createLorrenSupportTicketFromWhatsapp(prisma, {
      messageId: message.id,
      phone: message.from,
      text
    });
  } catch (error) {
    console.error('[LORREN_SUPPORT_TICKET_WEBHOOK_FAILED]', { messageId: message?.id || null, code: error?.message || 'unknown' });
  }
}

export function lorrenWhatsappWebhookRouter(prisma) {
  const router = express.Router();
  const parser = express.raw({ type: 'application/json', limit: '256kb' });
  router.get('/', lorrenWebhookVerification);
  router.post('/', parser, async (req, res) => {
    const config = getLorrenWhatsappConfig();
    const payload = verifiedPayload(req, config);
    if (!payload || !config.phoneNumberId) return res.sendStatus(401);
    res.sendStatus(200);
    for (const message of inboundMessages(payload, config.phoneNumberId)) {
      const handledBillingDecision = await handleBillingDecision(prisma, message);
      if (handledBillingDecision) continue;
      await handleSilentSupportTicket(prisma, message);
    }
    return undefined;
  });
  return router;
}
