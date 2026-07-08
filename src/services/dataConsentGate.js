import { CandidateStatus, ConversationStep, MessageDirection, MessageType } from '@prisma/client';
import { extractMessages, sendTextMessage } from './whatsapp.js';
import { buildCandidateDataCollectionMessage } from './readinessGuard.js';

export const DATA_CONSENT_VERSION = 'lorren-v2-2026-07-v2';

export const DATA_CONSENT_TEXT = process.env.DATA_CONSENT_TEXT || 'Autorizo a LoginPro a tratar mis datos personales, hoja de vida y documentos enviados por WhatsApp para gestionar mi postulación, validar información, contactarme y conservar la trazabilidad del proceso. Entiendo que puedo solicitar consulta, actualización, corrección o revocatoria de esta autorización.';

export const CAMPAIGN_VACANCY_CONFIRMATION_MODE = 'campaign_vacancy_pending_confirmation';
export const DATA_CONSENT_PENDING_MODE = 'awaiting_data_consent';

const CONSENT_PROMPT = process.env.DATA_CONSENT_PROMPT || `Antes de pedirte datos personales, necesito tu autorización para tratar tus datos y hoja de vida con fines de reclutamiento de LoginPro.\n\n${DATA_CONSENT_TEXT}\n\nSi autorizas, responde “Acepto”. Si no deseas continuar, responde “No autorizo”.`;
const CONSENT_REVOKED_REPLY = 'Entendido. No continuaré con la postulación ni procesaré tus datos por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';
const VACANCY_NOT_CONFIRMED_REPLY = 'Entendido. Para ubicar bien tu proceso, cuéntame la ciudad y el cargo o vacante que te interesa.';

function normalize(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAny(text = '', patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

export function isConsentAcceptance(text = '') {
  const n = normalize(text);
  if (!n) return false;
  if (hasAny(n, [
    /\b(acepto|autorizo|autorizado|autorisado)\b/,
    /\b(si|sii|sip|claro|correcto|de acuerdo|dale|ok|listo)\b.*\b(acepto|autorizo)\b/,
    /\b(si|sii|sip|claro|correcto|de acuerdo|dale|ok|listo)\b$/
  ])) return true;
  return false;
}

export function isConsentRejection(text = '') {
  const n = normalize(text);
  if (!n) return false;
  return hasAny(n, [
    /\b(no autorizo|no acepto|no doy autorizacion|no deseo autorizar|no quiero autorizar)\b/,
    /\b(no|negativo|paso|no gracias)\b$/
  ]);
}

function isAffirmativeVacancyConfirmation(text = '') {
  const n = normalize(text);
  if (!n) return false;
  return hasAny(n, [
    /\b(si|sii|sip|claro|correcto|exacto|esa es|si es|de acuerdo|dale|ok|listo)\b/,
    /\b(confirmo|confirmado|me interesa|estoy interesado|estoy interesada|quiero aplicar|quiero postularme)\b/
  ]);
}

function isNegativeVacancyConfirmation(text = '') {
  const n = normalize(text);
  if (!n) return false;
  return hasAny(n, [
    /\b(no es|esa no|no es esa|otra vacante|otro cargo|no corresponde|equivocado|equivocada)\b/,
    /^no\b/,
    /\b(no me interesa|no quiero|no deseo|paso|no gracias)\b/
  ]);
}

function isInterestToContinue(text = '') {
  const n = normalize(text);
  if (!n) return false;
  if (isNegativeVacancyConfirmation(n)) return false;
  return hasAny(n, [
    /\b(me interesa|estoy interesado|estoy interesada|quiero aplicar|quiero postularme|quiero continuar|deseo continuar|continuar|sigo|sigamos)\b/,
    /\b(si|sii|sip|claro|correcto|de acuerdo|dale|ok|listo)\b$/
  ]);
}

function isConsentAlreadyAccepted(candidate = {}) {
  return candidate?.dataConsentStatus === 'ACCEPTED';
}

function isAwaitingCampaignVacancyConfirmation(candidate = {}) {
  return Boolean(candidate?.vacancyId && candidate?.botResumeMode === CAMPAIGN_VACANCY_CONFIRMATION_MODE);
}

function shouldBlockUntilConsent(candidate = {}, message = {}) {
  if (!candidate?.vacancyId) return false;
  if (isConsentAlreadyAccepted(candidate)) return false;
  if (candidate?.dataConsentStatus === 'REVOKED') return true;
  if (candidate?.botResumeMode === DATA_CONSENT_PENDING_MODE) return true;
  if (message.type !== 'text') {
    return [ConversationStep.COLLECTING_DATA, ConversationStep.CONFIRMING_DATA, ConversationStep.ASK_CV, ConversationStep.SCHEDULING, ConversationStep.SCHEDULED]
      .includes(candidate?.currentStep);
  }
  const body = inboundBody(message);
  if (candidate?.currentStep === ConversationStep.GREETING_SENT && isInterestToContinue(body)) return true;
  return [ConversationStep.COLLECTING_DATA, ConversationStep.CONFIRMING_DATA, ConversationStep.ASK_CV, ConversationStep.SCHEDULING, ConversationStep.SCHEDULED]
    .includes(candidate?.currentStep);
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

async function saveOutboundConsentGateMessage(prisma, candidateId, body, source, extraPayload = {}) {
  await prisma.message.create({
    data: {
      candidateId,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      body,
      rawPayload: { source, body, consentVersion: DATA_CONSENT_VERSION, ...extraPayload }
    }
  });
  await prisma.candidate.update({ where: { id: candidateId }, data: { lastOutboundAt: new Date() } });
}

async function sendAndStore(prisma, candidateId, to, body, source, extraPayload = {}) {
  await sendTextMessage(to, body);
  await saveOutboundConsentGateMessage(prisma, candidateId, body, source, extraPayload);
}

async function loadVacancy(prisma, vacancyId) {
  if (!vacancyId) return null;
  return prisma.vacancy.findUnique({
    where: { id: vacancyId },
    include: { operation: { include: { city: true } } }
  });
}

function vacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || '';
}

function vacancyTitle(vacancy = {}) {
  return vacancy?.title || vacancy?.role || 'esta vacante';
}

function buildVacancyConfirmationPrompt(vacancy = {}) {
  const city = vacancyCity(vacancy);
  const place = city ? ` en ${city}` : '';
  return `Hola, soy Lórren, asistente de selección de LoginPro. ¿Escribes por la vacante de ${vacancyTitle(vacancy)}${place}? Responde sí para confirmarlo o dime el cargo correcto.`;
}

function buildVacancyInfoReply(vacancy = {}) {
  const city = vacancyCity(vacancy);
  const parts = [`Perfecto, te comparto la información registrada de ${vacancyTitle(vacancy)}${city ? ` en ${city}` : ''}.`];
  if (vacancy.roleDescription) parts.push(`El cargo consiste en ${vacancy.roleDescription}.`);
  if (vacancy.requirements) parts.push(`Requisitos: ${vacancy.requirements}.`);
  if (vacancy.conditions) parts.push(`Condiciones: ${vacancy.conditions}.`);
  if (vacancy.requiredDocuments) parts.push(`Documentos para el proceso: ${vacancy.requiredDocuments}.`);
  parts.push('¿Te interesa continuar con esta postulación?');
  return parts.join('\n\n');
}

function buildConsentAcceptedReply(candidate = {}, vacancy = null) {
  const dataPrompt = buildCandidateDataCollectionMessage(candidate, vacancy);
  return dataPrompt
    ? `Gracias, tu autorización quedó registrada. ${dataPrompt}`
    : 'Gracias, tu autorización quedó registrada. Continuemos con tu postulación.';
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
        currentStep: accepted ? ConversationStep.COLLECTING_DATA : ConversationStep.DONE,
        status: accepted ? candidate.status : CandidateStatus.NUEVO,
        botResumeMode: null,
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

async function handleCampaignVacancyConfirmation(prisma, req, candidate, message, from, body, type) {
  const vacancy = await loadVacancy(prisma, candidate.vacancyId);
  if (!vacancy) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: null, vacancyId: null } });
    await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);
    await sendAndStore(prisma, candidate.id, from, VACANCY_NOT_CONFIRMED_REPLY, 'campaign_vacancy_missing');
    return true;
  }

  await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);

  if (isAffirmativeVacancyConfirmation(body)) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT, botResumeMode: null } });
    await sendAndStore(prisma, candidate.id, from, buildVacancyInfoReply(vacancy), 'campaign_vacancy_confirmed', { vacancyId: vacancy.id });
    return true;
  }

  if (isNegativeVacancyConfirmation(body)) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT, botResumeMode: null, vacancyId: null } });
    await sendAndStore(prisma, candidate.id, from, VACANCY_NOT_CONFIRMED_REPLY, 'campaign_vacancy_rejected', { previousVacancyId: vacancy.id });
    return true;
  }

  await sendAndStore(prisma, candidate.id, from, buildVacancyConfirmationPrompt(vacancy), 'campaign_vacancy_confirmation_prompt', { vacancyId: vacancy.id });
  return true;
}

async function handleConsentDecision(prisma, req, candidate, message, from, body, type) {
  await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);

  if (isConsentRejection(body)) {
    await recordConsent(prisma, req, candidate, 'REVOKED');
    await sendAndStore(prisma, candidate.id, from, CONSENT_REVOKED_REPLY, 'data_consent_revoked');
    return true;
  }

  if (isConsentAcceptance(body)) {
    await recordConsent(prisma, req, candidate, 'ACCEPTED');
    const vacancy = await loadVacancy(prisma, candidate.vacancyId);
    const acceptedCandidate = { ...candidate, dataConsentStatus: 'ACCEPTED', currentStep: ConversationStep.COLLECTING_DATA, botResumeMode: null };
    await sendAndStore(prisma, candidate.id, from, buildConsentAcceptedReply(acceptedCandidate, vacancy), 'data_consent_accepted');
    return true;
  }

  await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: DATA_CONSENT_PENDING_MODE } });
  await sendAndStore(prisma, candidate.id, from, CONSENT_PROMPT, 'data_consent_prompt');
  return true;
}

export function dataConsentGateMiddleware(prisma) {
  return async (req, res, next) => {
    try {
      const messages = extractMessages(req.body);
      if (!messages.length) return next();

      let blockedByGate = false;

      for (const message of messages) {
        const from = message?.from;
        if (!from) continue;

        const candidate = await prisma.candidate.upsert({
          where: { phone: from },
          update: {},
          create: { phone: from }
        });

        const type = inboundMessageType(message);
        const body = inboundBody(message);

        if (isAwaitingCampaignVacancyConfirmation(candidate)) {
          blockedByGate = await handleCampaignVacancyConfirmation(prisma, req, candidate, message, from, body, type);
          continue;
        }

        if (shouldBlockUntilConsent(candidate, message)) {
          blockedByGate = await handleConsentDecision(prisma, req, candidate, message, from, body, type);
          continue;
        }
      }

      if (blockedByGate) return res.sendStatus(200);
      return next();
    } catch (error) {
      console.warn('[DATA_CONSENT_GATE_ERROR]', error?.message || error);
      return next();
    }
  };
}
