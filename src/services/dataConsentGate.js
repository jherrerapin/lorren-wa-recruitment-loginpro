import { ConversationStep, MessageDirection, MessageType } from '@prisma/client';
import { extractMessages, sendTextMessage } from './whatsapp.js';

export const DATA_CONSENT_VERSION = 'loren-v2-2026-06-v1';

export const DATA_CONSENT_TEXT = 'Para continuar con tu postulación necesito solicitar y tratar algunos datos personales y documentos relacionados con el proceso de selección. Autorizo de manera libre, previa, expresa e informada el tratamiento de mis datos personales y documentos aportados dentro del proceso de reclutamiento y selección de LoginPro / Loren. Esto incluye contacto por WhatsApp u otros canales digitales, registro de mis datos, análisis de hoja de vida, validación de información suministrada y conservación de la trazabilidad del proceso. Entiendo que puedo solicitar información, actualización, rectificación o revocatoria de esta autorización.';

const CONSENT_PROMPT = `${DATA_CONSENT_TEXT}\n\nSi deseas continuar con la postulación, responde: Acepto.\nSi no autorizas el tratamiento de datos, responde: No autorizo.`;
const CONSENT_ACCEPTED_REPLY = 'Gracias. Tu autorización quedó registrada. Ahora sí puedo continuar con tu postulación. Por favor compárteme tus datos para el registro.';
const CONSENT_REVOKED_REPLY = 'Entendido. No continuaré con la postulación ni procesaré tus datos por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribir: Acepto.';

function normalize(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function isConsentAcceptance(text = '') {
  const n = normalize(text);
  return ['acepto', 'autorizo', 'si autorizo', 'acepto y autorizo'].includes(n);
}

function isConsentRejection(text = '') {
  const n = normalize(text);
  return ['no autorizo', 'no acepto', 'no doy autorizacion', 'no doy autorizacion de datos'].includes(n);
}

function isConsentAlreadyAccepted(candidate = {}) {
  return candidate?.dataConsentStatus === 'ACCEPTED';
}

function shouldAllowInformationalFlow(candidate = {}, message = {}) {
  if (message.type !== 'text') return false;
  if (candidate?.dataConsentStatus === 'REVOKED') return false;
  return [ConversationStep.MENU, ConversationStep.GREETING_SENT].includes(candidate?.currentStep);
}

async function saveInboundConsentGateMessage(prisma, candidateId, message, body, type) {
  const waMessageId = message?.id || null;
  await prisma.message.createMany({
    data: [{
      candidateId,
      waMessageId,
      direction: MessageDirection.INBOUND,
      messageType: type,
      body,
      rawPayload: { source: 'data_consent_gate', original: message }
    }],
    skipDuplicates: true
  });
}

async function saveOutboundConsentGateMessage(prisma, candidateId, body, source) {
  await prisma.message.create({
    data: {
      candidateId,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      body,
      rawPayload: { source, body, consentVersion: DATA_CONSENT_VERSION }
    }
  });
  await prisma.candidate.update({ where: { id: candidateId }, data: { lastOutboundAt: new Date() } });
}

async function sendAndStore(prisma, candidateId, to, body, source) {
  await sendTextMessage(to, body);
  await saveOutboundConsentGateMessage(prisma, candidateId, body, source);
}

async function recordConsent(prisma, req, candidate, status) {
  const now = new Date();
  const accepted = status === 'ACCEPTED';
  await prisma.$transaction([
    prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        dataConsentStatus: status,
        dataConsentVersion: DATA_CONSENT_VERSION,
        dataConsentText: DATA_CONSENT_TEXT,
        dataConsentSource: 'WHATSAPP_CANDIDATE',
        dataConsentAcceptedAt: accepted ? now : null,
        dataConsentRevokedAt: accepted ? null : now,
        dataConsentRecordedBy: 'candidate_whatsapp',
        lastInboundAt: now
      }
    }),
    prisma.candidateDataConsentEvent.create({
      data: {
        candidateId: candidate.id,
        status,
        version: DATA_CONSENT_VERSION,
        text: DATA_CONSENT_TEXT,
        source: 'WHATSAPP_CANDIDATE',
        actorUsername: 'candidate_whatsapp',
        ipAddress: req.ip || null,
        userAgent: req.get('user-agent') || null,
        note: accepted ? 'Aceptación registrada por respuesta de WhatsApp.' : 'Revocatoria registrada por respuesta de WhatsApp.'
      }
    })
  ]);
}

function inboundMessageType(message = {}) {
  if (message.type === 'document') return MessageType.DOCUMENT;
  if (message.type === 'image') return MessageType.IMAGE;
  if (message.type === 'text') return MessageType.TEXT;
  if (message.type === 'interactive') return MessageType.INTERACTIVE;
  return MessageType.UNKNOWN;
}

function inboundBody(message = {}) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'document') return message.document?.filename || '[documento recibido antes de autorización]';
  if (message.type === 'image') return message.image?.caption || '[imagen recibida antes de autorización]';
  return `[${message.type || 'mensaje'} recibido antes de autorización]`;
}

export function dataConsentGateMiddleware(prisma) {
  return async (req, res, next) => {
    try {
      const messages = extractMessages(req.body);
      if (!messages.length) return next();

      let blockedByConsent = false;

      for (const message of messages) {
        const from = message?.from;
        if (!from) continue;

        const candidate = await prisma.candidate.upsert({
          where: { phone: from },
          update: {},
          create: { phone: from }
        });

        if (isConsentAlreadyAccepted(candidate)) continue;

        const type = inboundMessageType(message);
        const body = inboundBody(message);

        if (message.type === 'text' && isConsentAcceptance(body)) {
          await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);
          await recordConsent(prisma, req, candidate, 'ACCEPTED');
          await sendAndStore(prisma, candidate.id, from, CONSENT_ACCEPTED_REPLY, 'data_consent_accepted');
          blockedByConsent = true;
          continue;
        }

        if (message.type === 'text' && isConsentRejection(body)) {
          await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);
          await recordConsent(prisma, req, candidate, 'REVOKED');
          await sendAndStore(prisma, candidate.id, from, CONSENT_REVOKED_REPLY, 'data_consent_revoked');
          blockedByConsent = true;
          continue;
        }

        if (shouldAllowInformationalFlow(candidate, message)) continue;

        await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);

        if (candidate.dataConsentStatus === 'REVOKED') {
          await sendAndStore(prisma, candidate.id, from, CONSENT_REVOKED_REPLY, 'data_consent_revoked_reminder');
          blockedByConsent = true;
          continue;
        }

        await sendAndStore(prisma, candidate.id, from, CONSENT_PROMPT, 'data_consent_prompt');
        blockedByConsent = true;
      }

      if (blockedByConsent) return res.sendStatus(200);
      return next();
    } catch (error) {
      console.warn('[DATA_CONSENT_GATE_ERROR]', error?.message || error);
      return next();
    }
  };
}
