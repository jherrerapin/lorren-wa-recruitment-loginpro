import { getCandidateReadiness, hasValidCv } from './readinessGuard.js';
import { analyzeConversationTurn } from './conversationIntent.js';
import { APPLICATION_INTEREST_PENDING_MODE } from './dataConsentGate.js';
import { detectCityFromText, detectOperationZoneEvidence, detectRoleHintFromText, findActiveVacancies, normalizeResolverText, resolveVacancyFromText } from './vacancyResolver.js';
import { evaluateVacancyConceptAlternative, VacancyConceptAlternativeAction } from './vacancyConceptMatcher.js';

const ConversationStep = Object.freeze({
  MENU: 'MENU',
  GREETING_SENT: 'GREETING_SENT',
  COLLECTING_DATA: 'COLLECTING_DATA',
  CONFIRMING_DATA: 'CONFIRMING_DATA',
  ASK_CV: 'ASK_CV',
  DONE: 'DONE'
});
const { MENU, GREETING_SENT, COLLECTING_DATA, CONFIRMING_DATA, ASK_CV, DONE } = ConversationStep;

export const VacancyFirstGateAction = Object.freeze({
  ALLOW_ENGINE: 'ALLOW_ENGINE',
  REPLY: 'REPLY',
  SUPPRESS_REPLY: 'SUPPRESS_REPLY',
  ASSIGN_VACANCY_AND_CONTINUE: 'ASSIGN_VACANCY_AND_CONTINUE',
  INACTIVE_VACANCY_REPLY: 'INACTIVE_VACANCY_REPLY',
  ENTER_FUTURE_PROFILE_CONSENT: 'ENTER_FUTURE_PROFILE_CONSENT'
});

export const FUTURE_PROFILE_OFFER_MODE = 'future_profile_offer';
export const FUTURE_PROFILE_CAPTURE_MODE = 'future_profile_capture';
export const PAUSED_VACANCY_OFFER_MODE = 'paused_vacancy';
export const PAUSED_VACANCY_CAPTURE_MODE = 'paused_vacancy_capture';
export const ALTERNATIVE_VACANCY_OFFER_MODE = 'alternative_vacancy_offer';
export const ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE = 'alternative_vacancy_prequalification';
export const VACANCY_CHANGE_OFFER_MODE = 'vacancy_change_offer';

const START_OR_INTAKE_STEPS = new Set([MENU, GREETING_SENT, COLLECTING_DATA, CONFIRMING_DATA, ASK_CV]);
const CLOSED_OR_REGISTERED_STATUSES = new Set(['REGISTRADO', 'VALIDANDO', 'APROBADO', 'CONTACTADO', 'CONTRATADO']);
const FUTURE_PROFILE_OFFER_REPLY_KINDS = new Set(['INACTIVE_VACANCY_FUTURE_PROFILE_OFFER', 'NO_ACTIVE_VACANCIES_FOR_CITY']);

function isOpenVacancy(vacancy = null) {
  return Boolean(vacancy?.isActive && vacancy?.acceptingApplications);
}

function vacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || null;
}

function isBogotaCity(city = '') {
  return normalizeResolverText(city) === 'bogota';
}

function vacancyTitle(vacancy = {}) {
  return vacancy?.title || vacancy?.role || 'la opción disponible';
}

function recentConversationText(recentMessages = []) {
  return (recentMessages || [])
    .slice(-6)
    .filter((message) => !message?.direction || message.direction === 'INBOUND')
    .map((message) => String(message?.body || ''))
    .filter(Boolean)
    .join('\n');
}

export function buildVacancyResolutionText(inboundText = '', recentMessages = []) {
  const currentText = String(inboundText || '').trim();
  const turn = analyzeConversationTurn(currentText);
  const hasCurrentVacancyEvidence = Boolean(
    detectCityFromText(currentText)
    || detectRoleHintFromText(currentText)
    || detectOperationZoneEvidence(currentText).length
  );

  if (turn.correction && hasCurrentVacancyEvidence) {
    return currentText.slice(-4000);
  }

  return [recentConversationText(recentMessages), currentText]
    .filter(Boolean)
    .join('\n')
    .slice(-4000);
}

function missingDataLabels(candidate = {}, vacancy = null) {
  const readiness = getCandidateReadiness(candidate, vacancy, { requireCv: false });
  return readiness.missingFieldLabels || [];
}

function buildActiveDataPrompt(candidate = {}, vacancy = null) {
  const labels = missingDataLabels(candidate, vacancy);
  if (labels.length) return `Perfecto, continuamos con esta vacante. Para avanzar, compárteme ${labels.join(', ')}.`;
  if (!hasValidCv(candidate)) return 'Perfecto, continuamos con esta vacante. Envíame tu hoja de vida como archivo PDF, DOC o DOCX.';
  return 'Perfecto, ya tengo la información principal. Continuo con el siguiente paso del proceso.';
}

function requiresConsentBeforeCollection(candidate = {}) {
  return String(candidate?.dataConsentStatus || '') === 'PENDING';
}

function buildAwaitingApplicationInterestUpdates(vacancyId) {
  return {
    vacancyId,
    currentStep: GREETING_SENT,
    botResumeMode: APPLICATION_INTEREST_PENDING_MODE,
    reminderScheduledFor: null,
    reminderState: 'SKIPPED'
  };
}

function buildActiveVacancyInterestReply(vacancy = {}, inboundText = '') {
  const answer = buildVacancyInformationAnswer(vacancy, inboundText);
  const city = vacancyCity(vacancy);
  const confirmation = answer || `Encontré la vacante de ${vacancyTitle(vacancy)}${city ? ` en ${city}` : ''}.`;
  return `${confirmation} ¿Deseas postularte y continuar con este proceso?`;
}

function missingDataPrompt(candidate = {}, vacancy = null) {
  const labels = missingDataLabels(candidate, vacancy);
  if (labels.length) return `Listo, dejo tu perfil como registro para futuras aperturas. Para hacerlo bien, compárteme ${labels[0]}.`;
  if (!hasValidCv(candidate)) return 'Listo, dejo tu perfil como registro para futuras aperturas. Si deseas actualizar o adjuntar tu hoja de vida, envíala en PDF o Word/DOCX.';
  return 'Listo, tu perfil queda registrado para futuras aperturas compatibles. No hay entrevista activa para agendar en este momento.';
}

function buildNoActiveVacanciesReply(city = null) {
  const location = city ? ` en ${city}` : '';
  return `En este momento no tengo vacantes activas${location}. Si quieres, puedo dejar tu perfil registrado para futuras aperturas compatibles; solo lo hago si me confirmas que deseas ese registro.`;
}

function buildNeedRoleForCityReply(city = null, roleHint = null) {
  const hasRoleHint = Boolean(String(roleHint || '').trim());
  if (hasRoleHint) {
    if (isBogotaCity(city)) return 'Gracias, ya tengo la ciudad y el cargo de interés. ¿En qué localidad vives?';
    return 'Gracias, ya tengo la ciudad y el cargo de interés. ¿Para qué operación o vacante viste la convocatoria?';
  }
  const localityPart = isBogotaCity(city) ? ' y en qué localidad estás' : '';
  return `Gracias por contarme desde dónde escribes. ¿Para qué vacante o cargo estás interesado${localityPart}?`;
}

function buildVacancyInformationAnswer(vacancy = null, inboundText = '') {
  if (!vacancy) return '';
  const turn = analyzeConversationTurn(inboundText);
  if (!turn.vacancyInformationRequest && !turn.question) return '';

  const normalized = normalizeResolverText(inboundText);
  const title = vacancyTitle(vacancy);
  const city = vacancyCity(vacancy);
  const location = city ? ` en ${city}` : '';
  const roleDescription = String(vacancy?.roleDescription || '').trim();
  const requirements = String(vacancy?.requirements || '').trim();
  const conditions = String(vacancy?.conditions || '').trim();
  const address = String(vacancy?.operationAddress || '').trim();
  const documents = String(vacancy?.requiredDocuments || '').trim();

  if (/\b(funcion|funciones|labor|labores|hace|hacer|haria|toca|consiste|responsabilidad|responsabilidades)\b/.test(normalized)) {
    return roleDescription
      ? `La función registrada para ${title}${location} es ${roleDescription}.`
      : `Tengo identificado el cargo de ${title}${location}, pero no hay una descripción adicional registrada.`;
  }

  if (/\b(requisito|requisitos|perfil|experiencia|estudio|formacion|moto|carro|transporte|vehiculo)\b/.test(normalized)) {
    return requirements
      ? `Los requisitos registrados para ${title}${location} son: ${requirements}.`
      : `No tengo requisitos adicionales registrados para ${title}${location}.`;
  }

  if (/\b(documento|documentos|papeles)\b/.test(normalized)) {
    return documents
      ? `Los documentos registrados para el proceso de ${title}${location} son: ${documents}.`
      : `No tengo documentos adicionales registrados para ${title}${location}.`;
  }

  if (/\b(salario|sueldo|pago|horario|turno|beneficio|beneficios|condiciones|contrato|prestaciones)\b/.test(normalized)) {
    return conditions
      ? `Las condiciones registradas para ${title}${location} son: ${conditions}.`
      : `Ese dato no está registrado para ${title}${location}.`;
  }

  if (/\b(ubicacion|direccion|zona|sector|donde|queda)\b/.test(normalized)) {
    return address
      ? `La zona registrada para ${title}${location} es ${address}.`
      : `No tengo una zona más detallada registrada para ${title}${location}.`;
  }

  const facts = [];
  if (roleDescription) facts.push(`El cargo consiste en ${roleDescription}.`);
  if (requirements) facts.push(`Los requisitos registrados son: ${requirements}.`);
  if (conditions) facts.push(`Las condiciones registradas son: ${conditions}.`);
  if (address) facts.push(`La zona de operación registrada es ${address}.`);
  if (documents) facts.push(`Los documentos registrados para el proceso son: ${documents}.`);

  return facts.length
    ? `Claro. Sobre ${title}${location}: ${facts.join(' ')}`
    : `Tengo identificada la convocatoria de ${title}${location}, pero no hay información adicional cargada.`;
}

function buildInactiveVacancyReply(vacancy = null, city = null, inboundText = '') {
  const role = vacancyTitle(vacancy) || 'esa convocatoria';
  const place = vacancyCity(vacancy) || city;
  const location = place ? ` en ${place}` : '';
  const answer = buildVacancyInformationAnswer(vacancy, inboundText);
  const availability = `En este momento la convocatoria de ${role}${location} no está activa para recibir postulaciones. Si quieres, puedo dejar tu perfil registrado para futuras aperturas compatibles; solo avanzo con tus datos si me confirmas que deseas ese registro.`;
  return [answer, availability].filter(Boolean).join('\n\n');
}

function buildRegisteredWithoutVacancyReply(candidate = {}) {
  if (hasValidCv(candidate)) return 'Ya tengo tu registro y hoja de vida recibidos. En este momento quedan pendientes de revisión frente a nuevas oportunidades compatibles; no necesito pedirte nuevamente datos ni hoja de vida.';
  return 'Ya tengo tu registro base. Cuando exista una oportunidad compatible o necesitemos actualizar información, te orientamos por este medio.';
}

function hasRecentAttachmentGuidance(recentMessages = []) {
  return (recentMessages || []).some((message) => {
    if (message?.direction && message.direction !== 'OUTBOUND') return false;
    const payload = message?.rawPayload || {};
    const intent = payload.replyIntent || payload.fallbackIntent;
    return payload.source === 'bot_attachment_rate_limit'
      || payload.situation === 'attachment_resume_photo'
      || ['request_cv_pdf_word', 'request_missing_cv', 'attachment_other_doc', 'attachment_unreadable'].includes(intent);
  });
}

function isFutureProfileCaptureMode(mode = '') {
  return [FUTURE_PROFILE_CAPTURE_MODE, PAUSED_VACANCY_CAPTURE_MODE].includes(String(mode || ''));
}

function isFutureProfileOfferMode(mode = '') {
  return [FUTURE_PROFILE_OFFER_MODE, PAUSED_VACANCY_OFFER_MODE].includes(String(mode || ''));
}

function parseAlternativeMode(mode = '') {
  const [kind, vacancyId] = String(mode || '').split(':');
  if (![ALTERNATIVE_VACANCY_OFFER_MODE, ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE, VACANCY_CHANGE_OFFER_MODE].includes(kind)) return { active: false, kind: null, vacancyId: null };
  return { active: true, kind, vacancyId: vacancyId || null };
}

function buildAlternativeMode(kind, vacancyId = '') {
  return vacancyId ? `${kind}:${vacancyId}` : kind;
}

function isAlternativeOfferMode(mode = '') {
  return parseAlternativeMode(mode).active;
}

function getLastOutboundBotDecision(recentMessages = []) {
  return [...(recentMessages || [])]
    .reverse()
    .filter((message) => !message?.direction || message.direction === 'OUTBOUND')
    .find((message) => {
      const payload = message?.rawPayload || {};
      const source = String(payload.source || '');
      const actor = String(payload.actor || 'BOT');
      return actor !== 'RECRUITER' && actor !== 'ADMIN' && (source === 'vacancy_first_gate' || source.startsWith('bot_') || source === 'bot_flow');
    }) || null;
}

function detectAffirmationIntent(text = '') {
  const normalized = normalizeResolverText(text);
  if (!normalized) return { affirmative: false, passiveAck: false };
  const tokens = new Set(normalized.split(' ').filter(Boolean));
  const hasActiveConfirmation = tokens.has('confirmo')
    || tokens.has('acepto')
    || /\b(de acuerdo|claro que si|si confirmo|dale|hagale|listo|me interesa|continuar|quiero continuar|esta es la vacante|es la vacante)\b/.test(normalized)
    || (/\bsi\b/.test(normalized) && !/\bpero\b/.test(normalized));
  const passiveAck = /^(a\s*)?(bueno|ok|okay|entiendo|vale|gracias|listo gracias|perfecto gracias)$/.test(normalized)
    || (/\b(entendido|comprendo)\b/.test(normalized) && !hasActiveConfirmation);
  return { affirmative: hasActiveConfirmation, passiveAck };
}

function detectNegativeAlternativeIntent(text = '') {
  const normalized = normalizeResolverText(text);
  if (!normalized) return false;
  return /^(no|no gracias|nop|negativo|paso|mejor no|prefiero no)\b/.test(normalized)
    || /\b(solo|unicamente|solamente)\b.*\b(servicio|servicios|cargo que mencione|lo que dije)\b/.test(normalized);
}

function isAlternativeVacancyQuestion(text = '') {
  return analyzeConversationTurn(text).vacancyInformationRequest;
}

function buildAlternativeVacancyInfoReply(vacancy = {}, inboundText = '') {
  const answer = buildVacancyInformationAnswer(vacancy, inboundText);
  return `${answer} Si esta opción te interesa, respóndeme que deseas continuar y te pido los datos necesarios.`;
}

function buildVacancyChangeOfferReply(vacancy = {}) {
  const title = vacancyTitle(vacancy);
  const city = vacancyCity(vacancy);
  const location = city ? ` en ${city}` : '';
  return `Encontré la vacante ${title}${location}. Tu proceso actual no cambiará todavía. Confírmame si deseas cambiar a esta vacante.`;
}

function buildVacancyChangeInfoReply(vacancy = {}, inboundText = '') {
  const answer = buildVacancyInformationAnswer(vacancy, inboundText);
  return [answer, 'Si deseas cambiar tu proceso a esta vacante, confírmamelo.'].filter(Boolean).join(' ');
}

function buildVacancyChangeTargetPrompt(resolution = {}) {
  if (resolution?.city && !resolution?.roleHint) {
    return `Ya tengo la ciudad ${resolution.city}. Para cambiar tu proceso sin perder la vacante actual, dime el cargo exacto de la nueva vacante.`;
  }
  return 'Para cambiar tu proceso sin perder la vacante actual, indícame la ciudad y el cargo exactos de la nueva vacante.';
}

function evaluateFutureProfileConsent({ text = '', botResumeMode = '', recentMessages = [] } = {}) {
  const lastOutbound = getLastOutboundBotDecision(recentMessages);
  const lastReplyKind = lastOutbound?.rawPayload?.replyKind || null;
  const lastWasFutureOffer = FUTURE_PROFILE_OFFER_REPLY_KINDS.has(lastReplyKind);
  const inOfferMode = isFutureProfileOfferMode(botResumeMode);
  const intent = detectAffirmationIntent(text);
  const turn = analyzeConversationTurn(text);
  const normalized = normalizeResolverText(text);
  const explicitProfileIntent = /\b(dejar|registr|guardar|tomar|enviar|adjuntar|mandar|compartir)\b/.test(normalized)
    && /\b(perfil|hoja de vida|hv|datos|registro|registrada|registrado)\b/.test(normalized);

  // Una pregunta o una solicitud de información tiene prioridad conversacional.
  // "Me interesa" expresa interés en la vacante, no autoriza por sí solo guardar el perfil.
  if (turn.question || turn.vacancyInformationRequest) {
    return { accepted: false, passiveAck: false, reason: 'information_request_before_future_profile_decision', lastReplyKind };
  }

  const explicitContextualAcceptance = turn.confirmation || explicitProfileIntent;
  if (inOfferMode && lastWasFutureOffer && explicitContextualAcceptance && intent.affirmative) {
    return { accepted: true, passiveAck: false, reason: 'contextual_affirmation_after_future_profile_offer', lastReplyKind };
  }
  if (inOfferMode && lastWasFutureOffer && intent.passiveAck) {
    return { accepted: false, passiveAck: true, reason: 'passive_ack_after_future_profile_offer', lastReplyKind };
  }
  if (intent.affirmative && explicitProfileIntent) {
    return { accepted: true, passiveAck: false, reason: 'explicit_future_profile_acceptance', lastReplyKind };
  }
  return { accepted: false, passiveAck: intent.passiveAck, reason: intent.passiveAck ? 'passive_ack' : 'no_acceptance_evidence', lastReplyKind };
}

function hasFutureProfileAcceptanceEvidence(text = '', context = {}) {
  return evaluateFutureProfileConsent({ text, ...context }).accepted;
}

function messageCreatedAtMs(message = {}) {
  const raw = message.createdAt || message.timestamp || message.rawPayload?.createdAt;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : Date.now();
}

export function hasRecentSameBotDecision({ recentMessages = [], replyKind = '', reason = '', windowMinutes = 10 } = {}) {
  if (!replyKind || !reason) return false;
  const since = Date.now() - (Number(windowMinutes) || 10) * 60 * 1000;
  return (recentMessages || []).some((message) => {
    if (message?.direction && message.direction !== 'OUTBOUND') return false;
    const payload = message?.rawPayload || {};
    const actor = String(payload.actor || 'BOT');
    if (actor === 'RECRUITER' || actor === 'ADMIN') return false;
    const source = String(payload.source || '');
    if (source && source !== 'vacancy_first_gate' && !source.startsWith('bot_')) return false;
    return payload.replyKind === replyKind && payload.reason === reason && messageCreatedAtMs(message) >= since;
  });
}

function hasMaterialVacancyEvidence(text = '', city = null) {
  return Boolean(detectRoleHintFromText(text, { city }) || detectOperationZoneEvidence(text).length);
}

function preventRepeatDecision(decision, { recentMessages = [], inboundText = '', city = null, currentStep = null } = {}) {
  if (!decision?.replyKind || !decision?.reason) return decision;
  const repeated = hasRecentSameBotDecision({ recentMessages, replyKind: decision.replyKind, reason: decision.reason, windowMinutes: 10 });
  const turn = analyzeConversationTurn(inboundText, { currentStep });
  if (!repeated || turn.actionable || hasMaterialVacancyEvidence(inboundText, city)) return decision;
  return {
    action: VacancyFirstGateAction.SUPPRESS_REPLY,
    reason: 'REPEAT_PREVENTED',
    replyKind: decision.replyKind,
    suppressedDecision: { reason: decision.reason, replyKind: decision.replyKind }
  };
}

function isRegisteredCompleteWithoutVacancy(candidate = {}, readiness = {}) {
  const closedOrRegistered = candidate?.currentStep === DONE || CLOSED_OR_REGISTERED_STATUSES.has(String(candidate?.status || ''));
  return Boolean(!candidate?.vacancyId && closedOrRegistered && readiness.coreDataComplete && readiness.hasValidCv);
}

function findVacancyInHints(vacancyHints = {}, vacancyId = null) {
  if (!vacancyId) return null;
  const pools = [vacancyHints?.activeVacancies, vacancyHints?.allVacancies, vacancyHints?.vacancies];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    const match = pool.find((vacancy) => vacancy?.id === vacancyId);
    if (match) return match;
  }
  return null;
}

async function loadVacancyById(prisma, vacancyId = null, vacancyHints = {}) {
  const hintedVacancy = findVacancyInHints(vacancyHints, vacancyId);
  if (hintedVacancy) return hintedVacancy;
  if (!vacancyId || typeof prisma?.vacancy?.findUnique !== 'function') return null;
  return prisma.vacancy.findUnique({ where: { id: vacancyId }, include: { operation: { include: { city: true } } } }).catch(() => null);
}

function buildCollectingDataUpdates(vacancyId = null) {
  return {
    ...(vacancyId ? { vacancyId } : {}),
    currentStep: COLLECTING_DATA,
    botResumeMode: null,
    reminderScheduledFor: null,
    reminderState: 'SKIPPED'
  };
}

async function evaluateAlternativeAcceptance({ prisma, candidate = {}, inboundText = '', vacancyHints = {} } = {}) {
  const alternativeMode = parseAlternativeMode(candidate?.botResumeMode);
  if (!alternativeMode.active) return null;

  const isVacancyChange = alternativeMode.kind === VACANCY_CHANGE_OFFER_MODE;
  const offerReplyKind = isVacancyChange
    ? 'VACANCY_CHANGE_OFFER'
    : (alternativeMode.kind === ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE ? 'ALTERNATIVE_PREQUALIFICATION_PROMPT' : 'ALTERNATIVE_VACANCY_OFFER');
  const intent = detectAffirmationIntent(inboundText);
  if (intent.passiveAck) {
    return {
      action: VacancyFirstGateAction.SUPPRESS_REPLY,
      reason: isVacancyChange ? 'PASSIVE_ACK_AFTER_VACANCY_CHANGE_OFFER' : 'PASSIVE_ACK_AFTER_ALTERNATIVE_OFFER',
      replyKind: offerReplyKind
    };
  }

  if (detectNegativeAlternativeIntent(inboundText)) {
    if (isVacancyChange) {
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ASSIGNED_VACANCY_CHANGE_DECLINED',
        replyKind: 'VACANCY_CHANGE_RETAINED',
        candidateUpdates: { currentStep: candidate.currentStep, botResumeMode: null, reminderScheduledFor: null, reminderState: 'SKIPPED' },
        reply: 'Entendido. Mantengo tu proceso en la vacante que ya tenías asociada.'
      };
    }
    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'ALTERNATIVE_VACANCY_DECLINED',
      replyKind: 'FUTURE_PROFILE_AFTER_ALTERNATIVE_DECLINED',
      candidateUpdates: { currentStep: GREETING_SENT, botResumeMode: FUTURE_PROFILE_OFFER_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },
      reply: 'Entendido. En ese caso no te asigno a esa convocatoria. Si deseas, puedo dejar tu perfil registrado para futuras aperturas compatibles; solo avanzo con tus datos si me confirmas que quieres ese registro.'
    };
  }

  const vacancy = await loadVacancyById(prisma, alternativeMode.vacancyId, vacancyHints);

  if (!intent.affirmative) {
    if (isAlternativeVacancyQuestion(inboundText) && vacancy && isOpenVacancy(vacancy)) {
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: isVacancyChange ? 'ASSIGNED_VACANCY_CHANGE_INFO_REQUEST' : 'ALTERNATIVE_VACANCY_INFO_REQUEST',
        replyKind: offerReplyKind,
        vacancyId: vacancy.id,
        vacancy,
        candidateUpdates: {
          currentStep: candidate.currentStep,
          botResumeMode: buildAlternativeMode(alternativeMode.kind, vacancy.id),
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        },
        reply: isVacancyChange
          ? buildVacancyChangeInfoReply(vacancy, inboundText)
          : buildAlternativeVacancyInfoReply(vacancy, inboundText)
      };
    }
    return null;
  }

  if (!vacancy || !isOpenVacancy(vacancy)) {
    if (isVacancyChange) {
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ASSIGNED_VACANCY_CHANGE_NOT_AVAILABLE',
        replyKind: 'VACANCY_CHANGE_RETAINED',
        candidateUpdates: { currentStep: candidate.currentStep, botResumeMode: null, reminderScheduledFor: null, reminderState: 'SKIPPED' },
        reply: 'Esa nueva vacante ya no está disponible. Mantengo tu proceso en la vacante que ya tenías asociada.'
      };
    }
    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'ALTERNATIVE_VACANCY_NOT_AVAILABLE',
      replyKind: 'ALTERNATIVE_NOT_AVAILABLE_FUTURE_PROFILE_OFFER',
      candidateUpdates: { currentStep: GREETING_SENT, botResumeMode: FUTURE_PROFILE_OFFER_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },
      reply: buildNoActiveVacanciesReply(vacancyCity(vacancy))
    };
  }

  return {
    action: VacancyFirstGateAction.REPLY,
    reason: isVacancyChange
      ? 'ASSIGNED_VACANCY_CHANGE_ACCEPTED'
      : (alternativeMode.kind === ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE ? 'ALTERNATIVE_PREQUALIFICATION_ACCEPTED' : 'ALTERNATIVE_VACANCY_ACCEPTED'),
    replyKind: 'ACTIVE_VACANCY_DATA_PROMPT',
    vacancyId: vacancy.id,
    vacancy,
    candidateUpdates: buildCollectingDataUpdates(vacancy.id),
    reply: buildActiveDataPrompt(candidate, vacancy)
  };
}

function isExplicitAssignedVacancyChange(text = '', currentStep = null) {
  if (!START_OR_INTAKE_STEPS.has(currentStep)) return false;
  const turn = analyzeConversationTurn(text, { currentStep });
  const hasMaterialCorrection = turn.correction && Boolean(
    detectCityFromText(text)
    || detectRoleHintFromText(text)
    || detectOperationZoneEvidence(text).length
  );
  return turn.primaryIntent === 'change_intent' || hasMaterialCorrection;
}

async function evaluateAssignedVacancyChange({
  prisma,
  candidate = {},
  currentVacancy = null,
  inboundText = '',
  currentStep = candidate?.currentStep,
  vacancyHints = {}
} = {}) {
  if (!candidate?.vacancyId || !isExplicitAssignedVacancyChange(inboundText, currentStep)) return null;

  const currentText = String(inboundText || '').trim();
  const resolution = await resolveVacancyFromText(prisma, currentText, {
    allVacancies: vacancyHints?.allVacancies,
    activeVacancies: vacancyHints?.activeVacancies
  });

  if (resolution.resolved && resolution.vacancy && isOpenVacancy(resolution.vacancy)) {
    if (resolution.vacancy.id === candidate.vacancyId) {
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ASSIGNED_VACANCY_CHANGE_SAME_VACANCY',
        replyKind: 'CURRENT_VACANCY_ALREADY_ASSOCIATED',
        vacancyId: candidate.vacancyId,
        vacancy: currentVacancy || resolution.vacancy,
        resolution,
        reply: 'La vacante que mencionas ya es la que tienes asociada. Mantengo tu proceso actual.'
      };
    }

    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'ASSIGNED_VACANCY_CHANGE_OFFERED',
      replyKind: 'VACANCY_CHANGE_OFFER',
      vacancyId: resolution.vacancy.id,
      vacancy: resolution.vacancy,
      candidateUpdates: {
        currentStep: GREETING_SENT,
        botResumeMode: buildAlternativeMode(VACANCY_CHANGE_OFFER_MODE, resolution.vacancy.id),
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      },
      resolution,
      reply: buildVacancyChangeOfferReply(resolution.vacancy)
    };
  }

  if (resolution.resolved && resolution.vacancy && !isOpenVacancy(resolution.vacancy)) {
    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'ASSIGNED_VACANCY_CHANGE_TARGET_NOT_ACTIVE',
      replyKind: 'VACANCY_CHANGE_RETAINED',
      vacancy: resolution.vacancy,
      resolution,
      reply: 'La nueva vacante que mencionas no está activa. Mantengo tu proceso en la vacante que ya tienes asociada.'
    };
  }

  if (['city_without_active_vacancies', 'no_active_vacancies'].includes(resolution.reason)) {
    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'ASSIGNED_VACANCY_CHANGE_TARGET_NOT_AVAILABLE',
      replyKind: 'VACANCY_CHANGE_RETAINED',
      resolution,
      reply: 'No encontré esa nueva vacante activa. Mantengo tu proceso en la vacante que ya tienes asociada.'
    };
  }

  return {
    action: VacancyFirstGateAction.REPLY,
    reason: 'ASSIGNED_VACANCY_CHANGE_NEEDS_TARGET',
    replyKind: 'ASK_VACANCY_CHANGE_TARGET',
    resolution,
    reply: buildVacancyChangeTargetPrompt(resolution)
  };
}

async function buildAlternativeDecision({ prisma, resolution = {}, vacancyHints = {}, inboundText = '', recentMessages = [] } = {}) {
  const city = resolution.city || vacancyHints?.city || null;
  const requestedRoleText = resolution.roleHint || vacancyHints?.roleHint || detectRoleHintFromText(inboundText, { city });
  if (!city || !requestedRoleText) return null;
  const activeVacancies = vacancyHints?.activeVacancies || await findActiveVacancies(prisma);
  const alternative = evaluateVacancyConceptAlternative({ city, requestedRoleText, activeVacancies });
  if (alternative.action === VacancyConceptAlternativeAction.NONE) return null;
  const mode = alternative.action === VacancyConceptAlternativeAction.ASK_PREQUALIFICATION ? ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE : ALTERNATIVE_VACANCY_OFFER_MODE;
  const decision = {
    action: VacancyFirstGateAction.REPLY,
    reason: alternative.reason,
    replyKind: alternative.action === VacancyConceptAlternativeAction.ASK_PREQUALIFICATION ? 'ALTERNATIVE_PREQUALIFICATION_PROMPT' : 'ALTERNATIVE_VACANCY_OFFER',
    vacancyId: alternative.suggestedVacancyId,
    vacancy: alternative.suggestedVacancy,
    candidateUpdates: { currentStep: GREETING_SENT, botResumeMode: buildAlternativeMode(mode, alternative.suggestedVacancyId), reminderScheduledFor: null, reminderState: 'SKIPPED' },
    reply: alternative.reply,
    resolution: { ...resolution, suggestedVacancyId: alternative.suggestedVacancyId, alternativeReason: alternative.reason }
  };
  return preventRepeatDecision(decision, { recentMessages, inboundText, city, currentStep: GREETING_SENT });
}

export async function resolveVacancyFirstGate({
  prisma,
  candidate = {},
  currentVacancy = null,
  inboundText = '',
  currentStep = candidate?.currentStep,
  readiness = null,
  recentMessages = [],
  attachmentContext = null,
  vacancyHints = {}
} = {}) {
  const effectiveReadiness = readiness || getCandidateReadiness(candidate, currentVacancy);
  const botResumeMode = String(candidate?.botResumeMode || '');

  if (attachmentContext?.isAttachment && hasRecentAttachmentGuidance(recentMessages)) {
    return { action: VacancyFirstGateAction.SUPPRESS_REPLY, reason: 'RECENT_ATTACHMENT_GUIDANCE_ALREADY_SENT' };
  }

  const alternativeAcceptanceDecision = await evaluateAlternativeAcceptance({ prisma, candidate, inboundText, vacancyHints });
  if (alternativeAcceptanceDecision) return alternativeAcceptanceDecision;

  if (isFutureProfileCaptureMode(botResumeMode)) return { action: VacancyFirstGateAction.ALLOW_ENGINE, reason: 'FUTURE_PROFILE_CAPTURE_AUTHORIZED' };

  const futureProfileConsent = evaluateFutureProfileConsent({ text: inboundText, botResumeMode, recentMessages });
  if (isFutureProfileOfferMode(botResumeMode) && futureProfileConsent.passiveAck) {
    return { action: VacancyFirstGateAction.SUPPRESS_REPLY, reason: 'PASSIVE_ACK_AFTER_FUTURE_PROFILE_OFFER', replyKind: futureProfileConsent.lastReplyKind || null };
  }

  if (isAlternativeOfferMode(botResumeMode)) {
    const pendingAlternative = parseAlternativeMode(botResumeMode);
    return {
      action: VacancyFirstGateAction.SUPPRESS_REPLY,
      reason: pendingAlternative.kind === VACANCY_CHANGE_OFFER_MODE ? 'WAITING_FOR_VACANCY_CHANGE_DECISION' : 'WAITING_FOR_ALTERNATIVE_DECISION',
      replyKind: pendingAlternative.kind === VACANCY_CHANGE_OFFER_MODE ? 'VACANCY_CHANGE_OFFER' : 'ALTERNATIVE_VACANCY_OFFER'
    };
  }

  if (isRegisteredCompleteWithoutVacancy(candidate, effectiveReadiness)) {
    return { action: VacancyFirstGateAction.REPLY, reason: 'REGISTERED_COMPLETE_WITHOUT_VACANCY', replyKind: 'REGISTERED_PROFILE_CONTEXT', reply: buildRegisteredWithoutVacancyReply(candidate) };
  }

  const assignedVacancyChangeDecision = await evaluateAssignedVacancyChange({
    prisma,
    candidate,
    currentVacancy,
    inboundText,
    currentStep,
    vacancyHints
  });
  if (assignedVacancyChangeDecision) return assignedVacancyChangeDecision;

  if (currentVacancy || candidate?.vacancyId) {
    if (currentVacancy && !isOpenVacancy(currentVacancy)) {
      if (hasFutureProfileAcceptanceEvidence(inboundText, { botResumeMode, recentMessages })) {
        return {
          action: VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT,
          reason: 'PAUSED_VACANCY_FUTURE_PROFILE_ACCEPTED',
          replyKind: 'FUTURE_PROFILE_DATA_PROMPT',
          candidateUpdates: { currentStep: COLLECTING_DATA, botResumeMode: PAUSED_VACANCY_CAPTURE_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },
          reply: missingDataPrompt(candidate, currentVacancy)
        };
      }
      return preventRepeatDecision({
        action: VacancyFirstGateAction.REPLY,
        reason: 'VACANCY_NOT_ACTIVE',
        replyKind: 'INACTIVE_VACANCY_FUTURE_PROFILE_OFFER',
        candidateUpdates: { currentStep: GREETING_SENT, botResumeMode: PAUSED_VACANCY_OFFER_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },
        reply: buildInactiveVacancyReply(currentVacancy, null, inboundText)
      }, { recentMessages, inboundText, city: vacancyCity(currentVacancy), currentStep });
    }

    const intent = detectAffirmationIntent(inboundText);
    if (currentStep === GREETING_SENT && currentVacancy && intent.affirmative) {
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ACTIVE_VACANCY_CONFIRMED_ENTER_DATA',
        replyKind: 'ACTIVE_VACANCY_DATA_PROMPT',
        vacancyId: currentVacancy.id || candidate.vacancyId,
        vacancy: currentVacancy,
        candidateUpdates: buildCollectingDataUpdates(currentVacancy.id || candidate.vacancyId),
        reply: buildActiveDataPrompt(candidate, currentVacancy)
      };
    }

    return { action: VacancyFirstGateAction.ALLOW_ENGINE, reason: 'ACTIVE_VACANCY_ALREADY_RESOLVED' };
  }

  if (!START_OR_INTAKE_STEPS.has(currentStep)) return { action: VacancyFirstGateAction.ALLOW_ENGINE, reason: 'STEP_OUTSIDE_VACANCY_FIRST_INTAKE' };

  if (hasFutureProfileAcceptanceEvidence(inboundText, { botResumeMode, recentMessages })) {
    return {
      action: VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT,
      reason: 'NO_ACTIVE_VACANCY_FUTURE_PROFILE_ACCEPTED',
      replyKind: 'FUTURE_PROFILE_DATA_PROMPT',
      candidateUpdates: { currentStep: COLLECTING_DATA, botResumeMode: FUTURE_PROFILE_CAPTURE_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },
      reply: missingDataPrompt(candidate, null)
    };
  }

  const resolutionText = buildVacancyResolutionText(inboundText, recentMessages);
  const resolution = await resolveVacancyFromText(prisma, resolutionText || inboundText, {
    cityHint: vacancyHints?.city || null,
    roleHint: vacancyHints?.roleHint || null,
    allVacancies: vacancyHints?.allVacancies,
    activeVacancies: vacancyHints?.activeVacancies,
    trustedVacancyId: vacancyHints?.trustedVacancyId || vacancyHints?.metadataVacancyId || null,
    trustedVacancy: vacancyHints?.trustedVacancy || vacancyHints?.metadataVacancy || null
  });

  if (resolution.resolved && resolution.vacancy && isOpenVacancy(resolution.vacancy)) {
    if (requiresConsentBeforeCollection(candidate)) {
      return {
        action: VacancyFirstGateAction.REPLY,
        reason: 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST',
        replyKind: 'ACTIVE_VACANCY_INTEREST_PROMPT',
        vacancyId: resolution.vacancy.id,
        vacancy: resolution.vacancy,
        candidateUpdates: buildAwaitingApplicationInterestUpdates(resolution.vacancy.id),
        reply: buildActiveVacancyInterestReply(resolution.vacancy, inboundText),
        resolution
      };
    }
    return { action: VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE, reason: 'ACTIVE_VACANCY_RESOLVED', vacancyId: resolution.vacancy.id, vacancy: resolution.vacancy, resolution };
  }

  if (resolution.resolved && resolution.vacancy && !isOpenVacancy(resolution.vacancy)) {
    return preventRepeatDecision({
      action: VacancyFirstGateAction.INACTIVE_VACANCY_REPLY,
      reason: 'INACTIVE_VACANCY_RESOLVED',
      replyKind: 'INACTIVE_VACANCY_FUTURE_PROFILE_OFFER',
      vacancy: resolution.vacancy,
      candidateUpdates: {
        ...(resolution.reason === 'matched_inactive_vacancy' ? { vacancyId: resolution.vacancy.id } : {}),
        currentStep: GREETING_SENT,
        botResumeMode: PAUSED_VACANCY_OFFER_MODE,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      },
      reply: buildInactiveVacancyReply(resolution.vacancy, resolution.city, inboundText),
      resolution
    }, { recentMessages, inboundText, city: resolution.city, currentStep });
  }

  if (['trusted_vacancy_not_found'].includes(resolution.reason)) {
    return preventRepeatDecision({
      action: VacancyFirstGateAction.REPLY,
      reason: 'TRUSTED_VACANCY_NOT_AVAILABLE',
      replyKind: 'TRUSTED_VACANCY_NOT_AVAILABLE',
      candidateUpdates: { currentStep: GREETING_SENT, botResumeMode: FUTURE_PROFILE_OFFER_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },
      reply: buildNoActiveVacanciesReply(resolution.city),
      resolution
    }, { recentMessages, inboundText, city: resolution.city, currentStep });
  }

  if (['city_without_active_vacancies', 'no_active_vacancies'].includes(resolution.reason)) {
    return preventRepeatDecision({
      action: VacancyFirstGateAction.REPLY,
      reason: 'CITY_WITHOUT_ACTIVE_VACANCIES',
      replyKind: 'NO_ACTIVE_VACANCIES_FOR_CITY',
      candidateUpdates: { currentStep: GREETING_SENT, botResumeMode: FUTURE_PROFILE_OFFER_MODE, reminderScheduledFor: null, reminderState: 'SKIPPED' },
      reply: buildNoActiveVacanciesReply(resolution.city),
      resolution
    }, { recentMessages, inboundText, city: resolution.city, currentStep });
  }

  if (['city_with_active_vacancies', 'ambiguous_match', 'low_confidence_match'].includes(resolution.reason) && resolution.city) {
    const alternativeDecision = await buildAlternativeDecision({ prisma, resolution, vacancyHints, inboundText, recentMessages });
    if (alternativeDecision) return alternativeDecision;
    return preventRepeatDecision({
      action: VacancyFirstGateAction.REPLY,
      reason: 'CITY_WITH_ACTIVE_VACANCIES_ROLE_AMBIGUOUS',
      replyKind: 'ASK_CITY_LOCALITY_AND_ROLE',
      candidateUpdates: { currentStep: GREETING_SENT },
      reply: buildNeedRoleForCityReply(resolution.city, resolution.roleHint),
      resolution
    }, { recentMessages, inboundText, city: resolution.city, currentStep });
  }

  return preventRepeatDecision({
    action: VacancyFirstGateAction.REPLY,
    reason: 'VACANCY_NOT_RESOLVED',
    replyKind: 'ASK_CITY_AND_ROLE',
    candidateUpdates: { currentStep: GREETING_SENT },
    reply: 'Hola, gracias por comunicarte con LoginPro. ¿Desde qué ciudad nos escribes y para qué vacante?',
    resolution
  }, { recentMessages, inboundText, city: resolution?.city, currentStep });
}
