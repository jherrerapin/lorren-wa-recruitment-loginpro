import { CandidateStatus, ConversationStep, MessageDirection, MessageType } from '@prisma/client';
import { extractMessages, sendTextMessage } from './whatsapp.js';
import { buildCandidateDataCollectionMessage } from './readinessGuard.js';
import { captureConsentedProfileData } from './consentProfileCapture.js';
import { buildConsentQuestionReply } from './consentFaq.js';

export const DATA_CONSENT_VERSION = 'lorren-v2-2026-07-v3';

export const DATA_CONSENT_TEXT = process.env.DATA_CONSENT_TEXT || 'Autorizo a LoginPro a tratar mis datos personales, hoja de vida y documentos enviados por WhatsApp para gestionar mi postulación, validar información, contactarme y conservar la trazabilidad del proceso. Entiendo que puedo solicitar consulta, actualización, corrección o revocatoria de esta autorización.';

export const CAMPAIGN_VACANCY_CONFIRMATION_MODE = 'campaign_vacancy_pending_confirmation';
export const DATA_CONSENT_PENDING_MODE = 'awaiting_data_consent';

const PRE_CONSENT_CAPTURE_MODES = new Set([
  'future_profile_capture',
  'paused_vacancy_capture',
  'alternative_vacancy_prequalification'
]);

const PROTECTED_STEPS = new Set([
  ConversationStep.COLLECTING_DATA,
  ConversationStep.CONFIRMING_DATA,
  ConversationStep.ASK_CV,
  ConversationStep.SCHEDULING,
  ConversationStep.SCHEDULED
]);

const CONSENT_PROMPT = process.env.DATA_CONSENT_PROMPT || `Antes de recibir o guardar datos personales, hojas de vida o documentos, necesito tu autorización para tratarlos con fines de reclutamiento de LoginPro.\n\n${DATA_CONSENT_TEXT}\n\nPuedes responder de forma natural si autorizas o si no autorizas.`;
const CONSENT_CLARIFIER_REPLY = 'Para continuar necesito saber si autorizas a LoginPro a tratar tus datos y hoja de vida para este proceso. Puedes responder de forma natural si autorizas o si no autorizas.';
const CONSENT_REVOKED_REPLY = 'Entendido. No continuaré con la postulación ni procesaré tus datos por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';
const VACANCY_NOT_CONFIRMED_REPLY = 'Entendido. Para ubicar bien tu proceso, cuéntame la ciudad y el cargo o vacante que te interesa.';
const PRE_CONSENT_ATTACHMENT_REPLY = 'Recibí que intentaste enviar un archivo, pero todavía no lo descargué ni lo guardé. Antes de recibir datos, hojas de vida o documentos necesito tu autorización para el tratamiento de datos.';
const CONSENT_GATE_ERROR_REPLY = 'No pude validar tu autorización en este momento. Por seguridad no voy a recibir ni guardar datos o documentos. Intenta nuevamente más tarde.';

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

function isQuestionLike(text = '') {
  const raw = String(text || '').trim();
  const normalized = normalize(raw);
  if (!normalized) return false;
  return raw.includes('?') || hasAny(normalized, [
    /\b(cual|cuanto|cuando|donde|como|que|quien|por que)\b/,
    /\b(salario|sueldo|pago|horario|turno|requisito|funcion|ubicacion|direccion|contrato|beneficio)\b/
  ]);
}

function startsWithExplicitConsent(text = '') {
  return /^(si|sii|sip|claro|correcto|de acuerdo|acepto|autorizo|consiento|estoy de acuerdo|doy mi consentimiento|doy consentimiento|doy permiso)\b/.test(text);
}

function startsWithExplicitVacancyConfirmation(text = '') {
  return /^(si|sii|sip|claro|correcto|exacto|esa es|si es|de acuerdo|confirmo|confirmado|me interesa|estoy interesado|estoy interesada|quiero aplicar|quiero postularme)\b/.test(text);
}

export function isConsentAcceptance(text = '') {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (isQuestionLike(text) && !startsWithExplicitConsent(normalized)) return false;
  return hasAny(normalized, [
    /\b(acepto|autorizo|autorizado|autorisado|consiento)\b/,
    /\b(si|sii|sip|claro|correcto|de acuerdo|dale|ok|listo)\b.*\b(acepto|autorizo|consiento)\b/,
    /\b(estoy de acuerdo|doy mi consentimiento|doy consentimiento|doy permiso|tienen mi permiso|autorizacion concedida)\b/,
    /\b(pueden|puede)\s+(usar|tratar|manejar|procesar|guardar)\s+(mis|los)\s+datos\b/,
    /\b(pueden|puede)\s+continuar\s+con\s+(mis|los)\s+datos\b/,
    /\b(si|sii|sip|claro|correcto|de acuerdo|dale|ok|listo|continuemos|sigamos)\b$/
  ]);
}

export function isConsentRejection(text = '') {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (isQuestionLike(text) && !/^(no|negativo|no autorizo|no acepto|no doy)\b/.test(normalized)) return false;
  return hasAny(normalized, [
    /\b(no autorizo|no acepto|no doy autorizacion|no doy permiso|no deseo autorizar|no quiero autorizar|no permito el uso de mis datos)\b/,
    /\b(no|negativo|paso|no gracias)\b$/
  ]);
}

function isAffirmativeVacancyConfirmation(text = '') {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (isQuestionLike(text) && !startsWithExplicitVacancyConfirmation(normalized)) return false;
  return hasAny(normalized, [
    /\b(si|sii|sip|claro|correcto|exacto|esa es|si es|de acuerdo|dale|ok|listo)\b/,
    /\b(confirmo|confirmado|me interesa|estoy interesado|estoy interesada|quiero aplicar|quiero postularme)\b/
  ]);
}

function isNegativeVacancyConfirmation(text = '') {
  const normalized = normalize(text);
  if (!normalized) return false;
  return hasAny(normalized, [
    /\b(no es|esa no|no es esa|otra vacante|otro cargo|no corresponde|equivocado|equivocada)\b/,
    /^no\b/,
    /\b(no me interesa|no quiero|no deseo|paso|no gracias)\b/
  ]);
}

function isInterestToContinue(text = '') {
  const normalized = normalize(text);
  if (!normalized || isNegativeVacancyConfirmation(normalized)) return false;
  return hasAny(normalized, [
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

function isProtectedAttachment(message = {}) {
  return !['text', 'interactive'].includes(String(message?.type || ''));
}

function inboundText(message = {}) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title
      || message.interactive?.button_reply?.id
      || message.interactive?.list_reply?.title
      || message.interactive?.list_reply?.id
      || '';
  }
  return '';
}

export function evaluateConsentBoundary(candidate = {}, message = {}) {
  if (isConsentAlreadyAccepted(candidate)) return { block: false, reason: 'consent_already_accepted' };
  if (candidate?.dataConsentStatus === 'REVOKED') return { block: true, reason: 'consent_revoked' };
  if (candidate?.botResumeMode === DATA_CONSENT_PENDING_MODE) return { block: true, reason: 'consent_pending' };
  if (PRE_CONSENT_CAPTURE_MODES.has(String(candidate?.botResumeMode || ''))) return { block: true, reason: 'capture_mode_without_consent' };
  if (isProtectedAttachment(message)) return { block: true, reason: 'attachment_before_consent' };
  if (PROTECTED_STEPS.has(candidate?.currentStep)) return { block: true, reason: 'protected_step_without_consent' };
  if (candidate?.currentStep === ConversationStep.GREETING_SENT && isInterestToContinue(inboundText(message))) {
    return { block: true, reason: 'candidate_wants_to_continue' };
  }
  return { block: false, reason: 'consent_not_required_for_this_turn' };
}

function inboundMessageType(message = {}) {
  if (message.type === 'document') return MessageType.DOCUMENT;
  if (message.type === 'image') return MessageType.IMAGE;
  if (message.type === 'text') return MessageType.TEXT;
  if (message.type === 'interactive') return MessageType.INTERACTIVE;
  return MessageType.UNKNOWN;
}

async function saveInboundConsentEvidence(prisma, candidateId, message, body, decision) {
  const waMessageId = message?.id || null;
  const result = await prisma.message.createMany({
    data: [{
      candidateId,
      waMessageId,
      direction: MessageDirection.INBOUND,
      messageType: inboundMessageType(message),
      body,
      rawPayload: {
        source: 'data_consent_gate',
        consentVersion: DATA_CONSENT_VERSION,
        consentDecision: decision,
        waMessageId
      }
    }],
    skipDuplicates: true
  });
  return result.count > 0;
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

function vacancyLocation(vacancy = {}) {
  return vacancy?.operationAddress || vacancy?.operation?.name || vacancyCity(vacancy) || '';
}

function buildVacancyConfirmationPrompt(vacancy = {}) {
  const city = vacancyCity(vacancy);
  const place = city ? ` en ${city}` : '';
  return `Hola, soy Lórren, asistente de selección de LoginPro. ¿Escribes por la vacante de ${vacancyTitle(vacancy)}${place}? Puedes confirmarme de forma natural o decirme el cargo correcto.`;
}

function buildVacancyInfoReply(vacancy = {}) {
  const city = vacancyCity(vacancy);
  const parts = [`Perfecto, te comparto la información registrada de ${vacancyTitle(vacancy)}${city ? ` en ${city}` : ''}.`];
  if (vacancy.roleDescription) parts.push(`El cargo consiste en ${vacancy.roleDescription}.`);
  if (vacancy.operationAddress) parts.push(`Zona de operación: ${vacancy.operationAddress}.`);
  if (vacancy.requirements) parts.push(`Requisitos: ${vacancy.requirements}.`);
  if (vacancy.conditions) parts.push(`Condiciones: ${vacancy.conditions}.`);
  if (vacancy.requiredDocuments) parts.push(`Documentos para el proceso: ${vacancy.requiredDocuments}.`);
  parts.push('¿Te interesa continuar con esta postulación?');
  return parts.join('\n\n');
}

export function buildVacancyQuestionReply(vacancy = {}, text = '') {
  if (!vacancy || !isQuestionLike(text)) return '';
  const normalized = normalize(text);
  const lead = `Sobre la vacante de ${vacancyTitle(vacancy)}`;

  if (/\b(salario|sueldo|pago|cuanto pagan|cuanto es)\b/.test(normalized)) {
    return vacancy.conditions
      ? `${lead}, las condiciones registradas son: ${vacancy.conditions}.`
      : 'No tengo un salario registrado para esta vacante.';
  }
  if (/\b(horario|turno|jornada|contrato|prestacion|beneficio|condicion)\b/.test(normalized)) {
    return vacancy.conditions
      ? `${lead}, las condiciones registradas son: ${vacancy.conditions}.`
      : 'No tengo esas condiciones registradas para esta vacante.';
  }
  if (/\b(requisito|perfil|edad|experiencia|estudio|formacion|documento|moto|carro|transporte|vehiculo)\b/.test(normalized)) {
    const parts = [];
    if (vacancy.requirements) parts.push(vacancy.requirements);
    if (vacancy.requiredDocuments && /\bdocumento\b/.test(normalized)) parts.push(`Documentos: ${vacancy.requiredDocuments}`);
    return parts.length
      ? `${lead}, los requisitos registrados son: ${parts.join('. ')}.`
      : 'No tengo ese requisito registrado para esta vacante.';
  }
  if (/\b(funcion|funciones|labor|hacer|cargo|rol|consiste|tarea|tareas|responsabilidad|responsabilidades)\b/.test(normalized)) {
    return vacancy.roleDescription
      ? `${lead}, el cargo consiste en ${vacancy.roleDescription}.`
      : `El cargo registrado es ${vacancyTitle(vacancy)}, pero no tengo una descripción adicional.`;
  }
  if (/\b(donde|direccion|ubicacion|zona|sector|queda)\b/.test(normalized)) {
    const location = vacancyLocation(vacancy);
    return location
      ? `${lead}, la ubicación registrada es ${location}.`
      : 'No tengo una ubicación específica registrada para esta vacante.';
  }
  return 'No tengo ese dato registrado en la vacante. Puedo continuar con la información disponible.';
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

async function handleCampaignVacancyConfirmation(prisma, candidate, message, from, body) {
  const vacancy = await loadVacancy(prisma, candidate.vacancyId);
  if (!vacancy) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: null, vacancyId: null } });
    await sendAndStore(prisma, candidate.id, from, VACANCY_NOT_CONFIRMED_REPLY, 'campaign_vacancy_missing');
    return true;
  }

  if (isProtectedAttachment(message)) {
    const reply = `${PRE_CONSENT_ATTACHMENT_REPLY}\n\n${buildVacancyConfirmationPrompt(vacancy)}`;
    await sendAndStore(prisma, candidate.id, from, reply, 'pre_consent_attachment_vacancy_pending', { vacancyId: vacancy.id });
    return true;
  }

  const questionReply = buildVacancyQuestionReply(vacancy, body);
  if (isAffirmativeVacancyConfirmation(body)) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT, botResumeMode: null } });
    const reply = [questionReply, buildVacancyInfoReply(vacancy)].filter(Boolean).join('\n\n');
    await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmed', { vacancyId: vacancy.id });
    return true;
  }

  if (isNegativeVacancyConfirmation(body)) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT, botResumeMode: null, vacancyId: null } });
    await sendAndStore(prisma, candidate.id, from, VACANCY_NOT_CONFIRMED_REPLY, 'campaign_vacancy_rejected', { previousVacancyId: vacancy.id });
    return true;
  }

  const reply = [questionReply, buildVacancyConfirmationPrompt(vacancy)].filter(Boolean).join('\n\n');
  await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmation_prompt', { vacancyId: vacancy.id });
  return true;
}

async function handleConsentDecision(prisma, req, candidate, message, from, body, boundaryReason) {
  const vacancy = await loadVacancy(prisma, candidate.vacancyId);

  if (isProtectedAttachment(message)) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: DATA_CONSENT_PENDING_MODE } });
    const reply = `${PRE_CONSENT_ATTACHMENT_REPLY}\n\n${CONSENT_PROMPT}`;
    await sendAndStore(prisma, candidate.id, from, reply, 'pre_consent_attachment_rejected', { reason: boundaryReason, vacancyId: vacancy?.id || null });
    return true;
  }

  const questionReply = buildConsentQuestionReply(body) || buildVacancyQuestionReply(vacancy, body);

  if (isConsentRejection(body)) {
    await saveInboundConsentEvidence(prisma, candidate.id, message, body, 'REVOKED');
    await recordConsent(prisma, req, candidate, 'REVOKED');
    await sendAndStore(prisma, candidate.id, from, CONSENT_REVOKED_REPLY, 'data_consent_revoked');
    return true;
  }

  if (isConsentAcceptance(body)) {
    await saveInboundConsentEvidence(prisma, candidate.id, message, body, 'ACCEPTED');
    await recordConsent(prisma, req, candidate, 'ACCEPTED');
    let captured = { candidate: null, capturedFields: [] };
    try {
      captured = await captureConsentedProfileData({ prisma, candidate, vacancy, currentText: body });
    } catch (error) {
      console.warn('[CONSENTED_PROFILE_CAPTURE_ERROR]', error?.message || error);
    }
    const acceptedCandidate = captured.candidate || { ...candidate, dataConsentStatus: 'ACCEPTED', currentStep: ConversationStep.COLLECTING_DATA, botResumeMode: null };
    const reply = [questionReply, buildConsentAcceptedReply(acceptedCandidate, vacancy)].filter(Boolean).join('\n\n');
    await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_accepted', { capturedFields: captured.capturedFields || [] });
    return true;
  }

  await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: DATA_CONSENT_PENDING_MODE } });
  const consentReply = candidate.botResumeMode === DATA_CONSENT_PENDING_MODE ? CONSENT_CLARIFIER_REPLY : CONSENT_PROMPT;
  const reply = [questionReply, consentReply].filter(Boolean).join('\n\n');
  await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_prompt', { reason: boundaryReason });
  return true;
}

async function notifyConsentGateFailure(messages = []) {
  const recipients = [...new Set(messages.map((message) => message?.from).filter(Boolean))];
  await Promise.allSettled(recipients.map((to) => sendTextMessage(to, CONSENT_GATE_ERROR_REPLY)));
}

export function dataConsentGateMiddleware(prisma) {
  return async (req, res, next) => {
    const messages = extractMessages(req.body);
    if (!messages.length) return next();

    try {
      let blockedByGate = false;

      for (const message of messages) {
        const from = message?.from;
        if (!from) continue;

        const candidate = await prisma.candidate.upsert({
          where: { phone: from },
          update: {},
          create: { phone: from }
        });
        const body = inboundText(message);

        if (isAwaitingCampaignVacancyConfirmation(candidate)) {
          blockedByGate = await handleCampaignVacancyConfirmation(prisma, candidate, message, from, body);
          continue;
        }

        const boundary = evaluateConsentBoundary(candidate, message);
        if (boundary.block) {
          blockedByGate = await handleConsentDecision(prisma, req, candidate, message, from, body, boundary.reason);
        }
      }

      if (blockedByGate) return res.sendStatus(200);
      return next();
    } catch (error) {
      console.warn('[DATA_CONSENT_GATE_ERROR]', error?.message || error);
      await notifyConsentGateFailure(messages);
      return res.sendStatus(200);
    }
  };
}
