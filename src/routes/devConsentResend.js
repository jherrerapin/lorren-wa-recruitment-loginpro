import express from 'express';
import { randomUUID } from 'node:crypto';
import { MessageDirection, MessageType } from '@prisma/client';
import { deliverAutomaticOutboundText } from '../services/automaticOutboundDeliveryService.js';
import {
  DATA_CONSENT_BUTTONS,
  DATA_CONSENT_VERSION,
  buildDataConsentPromptReply
} from '../services/dataConsentGate.js';
import { sendReplyButtonsMessage } from '../services/whatsapp.js';

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTORY_HEADING = '<h2>Historial de conversación</h2>';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function consentResendError(code, userMessage) {
  const error = new Error(code);
  error.code = code;
  error.userMessage = userMessage;
  return error;
}

function candidateDetailRedirect(candidateId, key, message) {
  const params = new URLSearchParams();
  params.set(key, message);
  return `/admin/candidates/${encodeURIComponent(candidateId)}?${params.toString()}`;
}

export function canShowDevConsentResend(candidate = {}) {
  return String(candidate?.dataConsentStatus || '').trim().toUpperCase() === 'PENDING';
}

export function buildConsentResendIdempotencyKey(candidateId, nonce) {
  const normalizedCandidateId = normalizeId(candidateId);
  const normalizedNonce = normalizeId(nonce);
  if (!normalizedCandidateId) throw new TypeError('dev_consent_resend_candidate_id_required');
  if (!normalizedNonce || !UUID_PATTERN.test(normalizedNonce)) {
    throw new TypeError('dev_consent_resend_nonce_invalid');
  }
  return `admin-resend-data-consent:${normalizedCandidateId}:${DATA_CONSENT_VERSION}:${normalizedNonce}`;
}

export function buildDevConsentResendForm({ candidate = {}, outboundWindow = null, nonce = randomUUID() } = {}) {
  if (!canShowDevConsentResend(candidate)) return '';
  const candidateId = normalizeId(candidate.id);
  if (!candidateId) return '';
  const windowOpen = outboundWindow?.isOpen === true;
  const disabled = windowOpen ? '' : ' disabled title="Ventana de 24h cerrada"';
  const statusText = windowOpen
    ? 'Reenvía el mismo consentimiento con los botones Sí autorizo / No autorizo.'
    : 'La ventana de 24h está cerrada; no se puede reenviar el consentimiento.';

  return `<div data-dev-consent-resend="true" style="margin:10px 0 14px;padding:10px 12px;border:1px solid #dbeafe;border-radius:8px;background:#eff6ff;">
    <form method="post" action="/admin/candidates/${escapeHtml(candidateId)}/resend-data-consent" class="status-form" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0;">
      <input type="hidden" name="nonce" value="${escapeHtml(nonce)}" />
      <button type="submit" class="btn-primary"${disabled}>Reenviar autorización</button>
      <span style="font-size:12px;color:#475569;">${statusText}</span>
    </form>
  </div>`;
}

export function injectDevConsentResendAction(html, context = {}) {
  if (typeof html !== 'string' || !html.includes(HISTORY_HEADING)) return html;
  const form = buildDevConsentResendForm(context);
  if (!form) return html;
  return html.replace(HISTORY_HEADING, `${HISTORY_HEADING}\n${form}`);
}

async function latestInboundAt(prisma, candidateId) {
  const message = await prisma.message.findFirst({
    where: {
      candidateId,
      direction: MessageDirection.INBOUND
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true }
  });
  return message?.createdAt || null;
}

export async function resendDataConsentFromDev(prisma, input = {}, dependencies = {}) {
  const candidateId = normalizeId(input.candidateId);
  if (!candidateId) throw consentResendError('dev_consent_resend_candidate_id_required', 'Candidato no encontrado.');
  const idempotencyKey = buildConsentResendIdempotencyKey(candidateId, input.nonce);
  const now = typeof dependencies.now === 'function' ? dependencies.now : (() => new Date());
  const deliver = dependencies.deliver || deliverAutomaticOutboundText;
  const sendButtons = dependencies.sendButtons || sendReplyButtonsMessage;

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      phone: true,
      dataConsentStatus: true
    }
  });
  if (!candidate) throw consentResendError('dev_consent_resend_candidate_not_found', 'Candidato no encontrado.');
  if (!canShowDevConsentResend(candidate)) {
    throw consentResendError(
      'dev_consent_resend_not_pending',
      'El consentimiento de este candidato ya no está pendiente; no se reenvió la autorización.'
    );
  }

  const currentTime = validDate(now());
  if (!currentTime) throw new TypeError('dev_consent_resend_clock_invalid');
  const inboundAt = validDate(await latestInboundAt(prisma, candidateId));
  const windowOpen = Boolean(
    inboundAt
    && currentTime.getTime() >= inboundAt.getTime()
    && currentTime.getTime() - inboundAt.getTime() <= WHATSAPP_WINDOW_MS
  );
  if (!windowOpen) {
    throw consentResendError(
      'dev_consent_resend_window_closed',
      'La ventana de 24h de WhatsApp está vencida. No se puede reenviar la autorización.'
    );
  }

  const body = buildDataConsentPromptReply();
  return deliver(prisma, {
    candidateId,
    to: candidate.phone,
    body,
    messageType: MessageType.INTERACTIVE,
    idempotencyKey,
    rawPayload: {
      source: 'admin_resend_data_consent',
      action: 'resend_data_consent',
      actor: 'DEV',
      manualIntervention: false,
      situation: 'data_consent_prompt',
      responsePurpose: 'data_consent',
      consentVersion: DATA_CONSENT_VERSION,
      buttons: DATA_CONSENT_BUTTONS.map((button) => ({ id: button.id, title: button.title }))
    }
  }, {
    sendText: (recipient, text) => sendButtons(recipient, text, DATA_CONSENT_BUTTONS),
    now
  });
}

export function devConsentResendUiMiddleware() {
  return (req, res, next) => {
    const path = String(req.path || req.url || '').split('?')[0];
    if (req.method !== 'GET' || req.session?.userRole !== 'dev' || !/^\/candidates\/[^/]+\/?$/.test(path)) {
      return next();
    }

    const originalRender = res.render.bind(res);
    res.render = (view, options, callback) => {
      if (view !== 'detail') return originalRender(view, options, callback);
      return originalRender(view, options, (error, html) => {
        if (error) {
          if (typeof callback === 'function') return callback(error);
          return next(error);
        }
        const rendered = injectDevConsentResendAction(html, {
          candidate: options?.candidate,
          outboundWindow: options?.outboundWindow,
          nonce: randomUUID()
        });
        if (typeof callback === 'function') return callback(null, rendered);
        return res.send(rendered);
      });
    };

    return next();
  };
}

export function devConsentResendRouter(prisma, dependencies = {}) {
  const router = express.Router();

  router.post('/candidates/:id/resend-data-consent', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    const candidateId = normalizeId(req.params.id);
    if (req.session?.userRole !== 'dev') {
      return res.status(403).send('Acceso restringido a desarrolladores');
    }

    try {
      const result = await resendDataConsentFromDev(prisma, {
        candidateId,
        nonce: req.body?.nonce
      }, dependencies);
      const message = result?.suppressed
        ? 'La solicitud de autorización ya había sido procesada; no se envió un duplicado.'
        : 'Solicitud de autorización reenviada correctamente.';
      return res.redirect(candidateDetailRedirect(candidateId, 'outboundSuccess', message));
    } catch (error) {
      console.error('[dev_consent_resend]', {
        code: String(error?.code || error?.message || 'unknown').slice(0, 120)
      });
      const message = error?.userMessage || 'No fue posible reenviar la autorización.';
      return res.redirect(candidateDetailRedirect(candidateId || '', 'outboundError', message));
    }
  });

  return router;
}
