import express from 'express';
import { cybionixWebhookVerification } from '../services/cybionixWhatsappClient.js';
import { resolveCybionixAttendanceApproval } from '../services/cybionixBillingWorkflow.js';

const DECISION_PATTERN = /^cybionix_billing:(approve|reject):(ASIS-\d{6})$/i;

function inboundMessages(body = {}) {
  const messages = [];
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      for (const message of Array.isArray(change?.value?.messages) ? change.value.messages : []) messages.push(message);
    }
  }
  return messages;
}

function replyPayload(message = {}) {
  return message?.interactive?.button_reply?.id
    || message?.button?.payload
    || null;
}

export function cybionixWhatsappWebhookRouter(prisma) {
  const router = express.Router();
  const parser = express.json({ limit: '256kb' });

  router.get('/', cybionixWebhookVerification);
  router.post('/', parser, async (req, res) => {
    res.sendStatus(200);
    for (const message of inboundMessages(req.body)) {
      const payload = replyPayload(message);
      const match = DECISION_PATTERN.exec(String(payload || '').trim());
      if (!match) continue;
      try {
        await resolveCybionixAttendanceApproval(prisma, {
          invoiceNumber: match[2].toUpperCase(),
          decision: match[1].toLowerCase() === 'approve' ? 'APPROVE' : 'REJECT',
          supervisorPhone: message.from || null
        });
      } catch (error) {
        console.error('[CYBIONIX_BILLING_WEBHOOK_FAILED]', {
          invoiceNumber: match[2],
          code: error?.message || 'unknown'
        });
      }
    }
  });

  return router;
}
