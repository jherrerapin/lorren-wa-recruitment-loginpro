import { CandidateStatus, ConversationStep, MessageDirection, MessageType } from '@prisma/client';
import { extractMessages, sendTextMessage } from './whatsapp.js';
import { buildCandidateDataCollectionMessage } from './readinessGuard.js';
import { captureGatedCvDocument, isSupportedGatedCvDocument } from './gatedCvCapture.js';

export const DATA_CONSENT_VERSION = 'lorren-v2-2026-07-v2';

export const DATA_CONSENT_TEXT = process.env.DATA_CONSENT_TEXT || 'Autorizo a LoginPro a tratar mis datos personales, hoja de vida y documentos enviados por WhatsApp para gestionar mi postulación, validar información, contactarme y conservar la trazabilidad del proceso. Entiendo que puedo solicitar consulta, actualización, corrección o revocatoria de esta autorización.';

export const CAMPAIGN_VACANCY_CONFIRMATION_MODE = 'campaign_vacancy_pending_confirmation';
export const DATA_CONSENT_PENDING_MODE = 'awaiting_data_consent';

const CONSENT_PROMPT = process.env.DATA_CONSENT_PROMPT || `Antes de pedirte datos personales, necesito tu autorización para tratar tus datos y hoja de vida con fines de reclutamiento de LoginPro.\n\n${DATA_CONSENT_TEXT}\n\nPuedes responder de forma natural si estás de acuerdo o si no autorizas.`;
const CONSENT_CLARIFIER_REPLY = 'Para continuar con la postulación necesito saber si autorizas a LoginPro a tratar tus datos y hoja de vida para este proceso. Puedes responder de forma natural si estás de acuerdo o si no autorizas.';
const CONSENT_REVOKED_REPLY = 'Entendido. No continuaré con la postulación ni procesaré tus datos por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';
const VACANCY_NOT_CONFIRMED_REPLY = 'Entendido. Para ubicar bien tu proceso, cuéntame la ciudad y el cargo o vacante que te interesa.';
const EARLY_CV_SAVED_REPLY = 'Recibí y guardé tu hoja de vida para asociarla a esta postulación.';
const EARLY_CV_RETRY_REPLY = 'Recibí el archivo, pero no pude guardarlo correctamente. Por favor envíalo nuevamente en PDF, DOC o DOCX.';

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
  const n = normalize(raw);
  if (!n) return false;
  return raw.includes('?') || hasAny(n, [
    /\b(cual|cuanto|cuando|donde|como|que|quien)\b/,
    /\b(salario|sueldo|pago|horario|turno|requisito|funcion|ubicacion|direccion|contrato|beneficio)\b/
  ]);
}

export function isConsentAcceptance(text = '') {
  const n = normalize(text);
  if (!n) return false;
  return hasAny(n, [
    /\b(acepto|autorizo|autorizado|autorisado|consiento)\b/,
    /\b(si|sii|sip|claro|correcto|de acuerdo|dale|ok|listo)\b.*\b(acepto|autorizo|consiento)\b/,
    /\b(estoy de acuerdo|doy mi consentimiento|doy consentimiento|doy permiso|tienen mi permiso|autorizacion concedida)\b/,
    /\b(pueden|puede)\s+(usar|tratar|manejar|procesar|guardar)\s+(mis|los)\s+datos\b/,
    /\b(pueden|puede)\s+continuar\s+con\s+(mis|los)\s+datos\b/,
    /\b(si|sii|sip|claro|correcto|de acuerdo|dale|ok|listo|continuemos|sigamos)\b$/
  ]);
}

export function isConsentRejection(text = '') {
  const n = normalize(text);
  if (!n) return false;
  return hasAny(n, [
    /\b(no autorizo|no acepto|no doy autorizacion|no doy permiso|no deseo autorizar|no quiero autorizar|no permito el uso de mis datos)\b/,
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
  const result = await prisma.message.createMany({
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
  const n = normalize(text);
  const lead = `Sobre la vacante de ${vacancyTitle(vacancy)}`;

  if (/\b(salario|sueldo|pago|cuanto pagan|cuanto es)\b/.test(n)) {
    return vacancy.conditions
      ? `${lead}, las condiciones registradas son: ${vacancy.conditions}.`
      : 'No tengo un salario registrado para esta vacante.';
  }
  if (/\b(horario|turno|jornada|contrato|prestacion|beneficio|condicion)\b/.test(n)) {
    return vacancy.conditions
      ? `${lead}, las condiciones registradas son: ${vacancy.conditions}.`
      : 'No tengo esas condiciones registradas para esta vacante.';
  }
  if (/\b(requisito|perfil|edad|experiencia|estudio|formacion|documento)\b/.test(n)) {
    const parts = [];
    if (vacancy.requirements) parts.push(vacancy.requirements);
    if (vacancy.requiredDocuments && /\bdocumento\b/.test(n)) parts.push(`Documentos: ${vacancy.requiredDocuments}`);
    return parts.length
      ? `${lead}, los requisitos registrados son: ${parts.join('. ')}.`
      : 'No tengo ese requisito registrado para esta vacante.';
  }
  if (/\b(funcion|funciones|labor|hacer|cargo|rol)\b/.test(n)) {
    return vacancy.roleDescription
      ? `${lead}, el cargo consiste en ${vacancy.roleDescription}.`
      : `El cargo registrado es ${vacancyTitle(vacancy)}, pero no tengo una descripción adicional.`;
  }
  if (/\b(donde|direccion|ubicacion|zona|sector|queda)\b/.test(n)) {
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

async function captureEarlyCvAndReply(prisma, candidate, message, from, vacancy, mode) {
  const type = inboundMessageType(message);
  const body = inboundBody(message);
  const isNew = await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);
  if (!isNew) return true;

  try {
    const result = await captureGatedCvDocument({ prisma, candidateId: candidate.id, message });
    if (!result.captured) {
      await sendAndStore(prisma, candidate.id, from, EARLY_CV_RETRY_REPLY, 'gated_cv_not_saved', { reason: result.reason });
      return true;
    }

    if (mode === CAMPAIGN_VACANCY_CONFIRMATION_MODE) {
      const reply = `${EARLY_CV_SAVED_REPLY}\n\n${buildVacancyConfirmationPrompt(vacancy)}`;
      await sendAndStore(prisma, candidate.id, from, reply, 'gated_cv_saved_vacancy_pending', { vacancyId: vacancy?.id || null, filename: result.filename });
      return true;
    }

    await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: DATA_CONSENT_PENDING_MODE } });
    const reply = `${EARLY_CV_SAVED_REPLY}\n\n${CONSENT_PROMPT}`;
    await sendAndStore(prisma, candidate.id, from, reply, 'gated_cv_saved_consent_pending', { vacancyId: vacancy?.id || null, filename: result.filename });
    return true;
  } catch (error) {
    console.warn('[GATED_CV_CAPTURE_ERROR]', error?.message || error);
    await sendAndStore(prisma, candidate.id, from, EARLY_CV_RETRY_REPLY, 'gated_cv_capture_error');
    return true;
  }
}

async function handleCampaignVacancyConfirmation(prisma, req, candidate, message, from, body, type) {
  const vacancy = await loadVacancy(prisma, candidate.vacancyId);
  if (!vacancy) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: null, vacancyId: null } });
    await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);
    await sendAndStore(prisma, candidate.id, from, VACANCY_NOT_CONFIRMED_REPLY, 'campaign_vacancy_missing');
    return true;
  }

  if (candidate.dataConsentStatus !== 'REVOKED' && isSupportedGatedCvDocument(message)) {
    return captureEarlyCvAndReply(prisma, candidate, message, from, vacancy, CAMPAIGN_VACANCY_CONFIRMATION_MODE);
  }

  await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);
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

async function handleConsentDecision(prisma, req, candidate, message, from, body, type) {
  const vacancy = await loadVacancy(prisma, candidate.vacancyId);
  if (candidate.dataConsentStatus !== 'REVOKED' && isSupportedGatedCvDocument(message)) {
    return captureEarlyCvAndReply(prisma, candidate, message, from, vacancy, DATA_CONSENT_PENDING_MODE);
  }

  await saveInboundConsentGateMessage(prisma, candidate.id, message, body, type);
  const questionReply = buildVacancyQuestionReply(vacancy, body);

  if (isConsentRejection(body)) {
    await recordConsent(prisma, req, candidate, 'REVOKED');
    await sendAndStore(prisma, candidate.id, from, CONSENT_REVOKED_REPLY, 'data_consent_revoked');
    return true;
  }

  if (isConsentAcceptance(body)) {
    await recordConsent(prisma, req, candidate, 'ACCEPTED');
    const acceptedCandidate = { ...candidate, dataConsentStatus: 'ACCEPTED', currentStep: ConversationStep.COLLECTING_DATA, botResumeMode: null };
    const reply = [questionReply, buildConsentAcceptedReply(acceptedCandidate, vacancy)].filter(Boolean).join('\n\n');
    await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_accepted');
    return true;
  }

  await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: DATA_CONSENT_PENDING_MODE } });
  const consentReply = candidate.botResumeMode === DATA_CONSENT_PENDING_MODE ? CONSENT_CLARIFIER_REPLY : CONSENT_PROMPT;
  const reply = [questionReply, consentReply].filter(Boolean).join('\n\n');
  await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_prompt');
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
