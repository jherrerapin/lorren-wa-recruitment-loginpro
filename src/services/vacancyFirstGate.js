import { getCandidateReadiness, hasValidCv } from './readinessGuard.js';
import { detectOperationZoneEvidence, detectRoleHintFromText, findActiveVacancies, normalizeResolverText, resolveVacancyFromText } from './vacancyResolver.js';
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

const START_OR_INTAKE_STEPS = new Set([
  MENU,
  GREETING_SENT,
  COLLECTING_DATA,
  CONFIRMING_DATA,
  ASK_CV
]);

const CLOSED_OR_REGISTERED_STATUSES = new Set(['REGISTRADO', 'VALIDANDO', 'APROBADO', 'CONTACTADO', 'CONTRATADO']);

function isOpenVacancy(vacancy = null) {
  return Boolean(vacancy?.isActive && vacancy?.acceptingApplications);
}

function vacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || null;
}

function isBogotaCity(city = '') {
  return normalizeResolverText(city) === 'bogota';
}

function recentConversationText(recentMessages = []) {
  return (recentMessages || [])
    .slice(-6)
    .filter((message) => !message?.direction || message.direction === 'INBOUND')
    .map((message) => String(message?.body || ''))
    .filter(Boolean)
    .join('\n');
}

function buildResolutionText(inboundText = '', recentMessages = []) {
  return [recentConversationText(recentMessages), inboundText]
    .filter(Boolean)
    .join('\n')
    .slice(-4000);
}

function missingDataPrompt(candidate = {}, vacancy = null) {
  const readiness = getCandidateReadiness(candidate, vacancy, { requireCv: false });
  const labels = readiness.missingFieldLabels || [];
  if (labels.length) return `Listo, dejo tu perfil como registro para futuras aperturas. Para hacerlo bien, compárteme ${labels[0]}.`;
  if (!hasValidCv(candidate)) return 'Listo, dejo tu perfil como registro para futuras aperturas. Si deseas actualizar o adjuntar tu hoja de vida, envíala en PDF o Word/DOCX.';
  return 'Listo, tu perfil queda registrado para futuras aperturas compatibles. No hay entrevista activa para agendar en este momento.';
}

function buildNoActiveVacanciesReply(city = null) {
  const location = city ? ` en ${city}` : '';
  return `En este momento no tengo vacantes activas${location}. Si quieres, puedo dejar tu perfil registrado para futuras aperturas compatibles; solo lo hago si me confirmas que deseas ese registro.`;
}

function buildNeedRoleForCityReply(city = null, roleHint = null) {
  const place = city ? `en ${city}` : 'en tu ciudad';
  const hasRoleHint = Boolean(String(roleHint || '').trim());
  if (hasRoleHint) {
    if (isBogotaCity(city)) {
      return `Gracias, ya tengo la ciudad y el cargo de interés. Para ubicar la convocatoria correcta ${place}, cuéntame en qué localidad estás o alguna referencia adicional de la convocatoria.`;
    }
    return `Gracias, ya tengo la ciudad y el cargo de interés. Para ubicar la convocatoria correcta ${place}, cuéntame alguna referencia adicional de la convocatoria.`;
  }

  const localityPart = isBogotaCity(city) ? ' y en qué localidad estás' : '';
  return `Gracias por contarme desde dónde escribes. ¿Para qué vacante o cargo estás interesado${localityPart}?`;
}

function buildInactiveVacancyReply(vacancy = null, city = null) {
  const role = vacancy?.title || vacancy?.role || 'esa convocatoria';
  const place = vacancyCity(vacancy) || city;
  const location = place ? ` en ${place}` : '';
  return `Tengo identificada la convocatoria de ${role}${location}, pero en este momento no está activa para recibir postulaciones. Si quieres, puedo dejar tu perfil registrado para futuras aperturas compatibles; solo avanzo con tus datos si me confirmas que deseas ese registro.`;
}

function buildRegisteredWithoutVacancyReply(candidate = {}) {
  if (hasValidCv(candidate)) {
    return 'Ya tengo tu registro y hoja de vida recibidos. En este momento quedan pendientes de revisión frente a nuevas oportunidades compatibles; no necesito pedirte nuevamente datos ni hoja de vida.';
  }
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
  if (![ALTERNATIVE_VACANCY_OFFER_MODE, ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE].includes(kind)) {
    return { active: false, kind: null, vacancyId: null };
  }
  return { active: true, kind, vacancyId: vacancyId || null };
}

function buildAlternativeMode(kind, vacancyId = '') {
  return vacancyId ? `${kind}:${vacancyId}` : kind;
}

function isAlternativeOfferMode(mode = '') {
  return parseAlternativeMode(mode).active;
}

const FUTURE_PROFILE_OFFER_REPLY_KINDS = new Set([
  'INACTIVE_VACANCY_FUTURE_PROFILE_OFFER',
  'NO_ACTIVE_VACANCIES_FOR_CITY'
]);

function getLastOutboundBotDecision(recentMessages = []) {
  return [...(recentMessages || [])]
    .reverse()
    .filter((message) => !message?.direction || message.direction === 'OUTBOUND')
    .find((message) => {
      const payload = message?.rawPayload || {};
      const source = String(payload.source || '');
      const actor = String(payload.actor || 'BOT');
      return actor !== 'RECRUITER'
        && actor !== 'ADMIN'
        && (source === 'vacancy_first_gate' || source.startsWith('bot_') || source === 'bot_flow');
    }) || null;
}

function detectAffirmationIntent(text = '') {
  const normalized = normalizeResolverText(text);
  if (!normalized) return { affirmative: false, passiveAck: false };
  const tokens = new Set(normalized.split(' ').filter(Boolean));
  const hasActiveConfirmation = tokens.has('confirmo')
    || tokens.has('acepto')
    || /\b(de acuerdo|claro que si|si confirmo|dale|hagale|listo)\b/.test(normalized)
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

function evaluateFutureProfileConsent({ text = '', botResumeMode = '', recentMessages = [] } = {}) {
  const lastOutbound = getLastOutboundBotDecision(recentMessages);
  const lastReplyKind = lastOutbound?.rawPayload?.replyKind || null;
  const lastWasFutureOffer = FUTURE_PROFILE_OFFER_REPLY_KINDS.has(lastReplyKind);
  const inOfferMode = isFutureProfileOfferMode(botResumeMode);
  const intent = detectAffirmationIntent(text);
  const normalized = normalizeResolverText(text);
  const explicitProfileIntent = /\b(dejar|registr|guardar|tomar|enviar|adjuntar|mandar|compartir)\b/.test(normalized)
    && /\b(perfil|hoja de vida|hv|datos|registro|registrada|registrado)\b/.test(normalized);

  if (inOfferMode && lastWasFutureOffer && intent.affirmative) {
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
    return payload.replyKind === replyKind
      && payload.reason === reason
      && messageCreatedAtMs(message) >= since;
  });
}

function hasMaterialVacancyEvidence(text = '', city = null) {
  return Boolean(
    detectRoleHintFromText(text, { city })
    || detectOperationZoneEvidence(text).length
  );
}

function preventRepeatDecision(decision, { recentMessages = [], inboundText = '', city = null } = {}) {
  if (!decision?.replyKind || !decision?.reason) return decision;
  const repeated = hasRecentSameBotDecision({
    recentMessages,
    replyKind: decision.replyKind,
    reason: decision.reason,
    windowMinutes: 10
  });
  if (!repeated || hasMaterialVacancyEvidence(inboundText, city)) return decision;
  return {
    action: VacancyFirstGateAction.SUPPRESS_REPLY,
    reason: 'REPEAT_PREVENTED',
    replyKind: decision.replyKind,
    suppressedDecision: { reason: decision.reason, replyKind: decision.replyKind }
  };
}

function isRegisteredCompleteWithoutVacancy(candidate = {}, readiness = {}) {
  const closedOrRegistered = candidate?.currentStep === DONE
    || CLOSED_OR_REGISTERED_STATUSES.has(String(candidate?.status || ''));
  return Boolean(
    !candidate?.vacancyId
    && closedOrRegistered
    && readiness.coreDataComplete
    && readiness.hasValidCv
  );
}

async function loadVacancyById(prisma, vacancyId = null) {
  if (!vacancyId || typeof prisma?.vacancy?.findUnique !== 'function') return null;
  return prisma.vacancy.findUnique({
    where: { id: vacancyId },
    include: { operation: { include: { city: true } } }
  }).catch(() => null);
}

async function evaluateAlternativeAcceptance({ prisma, candidate = {}, inboundText = '' } = {}) {
  const alternativeMode = parseAlternativeMode(candidate?.botResumeMode);
  if (!alternativeMode.active) return null;

  const intent = detectAffirmationIntent(inboundText);
  if (intent.passiveAck) {
    return {
      action: VacancyFirstGateAction.SUPPRESS_REPLY,
      reason: 'PASSIVE_ACK_AFTER_ALTERNATIVE_OFFER',
      replyKind: alternativeMode.kind === ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE
        ? 'ALTERNATIVE_PREQUALIFICATION_PROMPT'
        : 'ALTERNATIVE_VACANCY_OFFER'
    };
  }

  if (detectNegativeAlternativeIntent(inboundText)) {
    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'ALTERNATIVE_VACANCY_DECLINED',
      replyKind: 'FUTURE_PROFILE_AFTER_ALTERNATIVE_DECLINED',
      candidateUpdates: {
        currentStep: GREETING_SENT,
        botResumeMode: FUTURE_PROFILE_OFFER_MODE,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      },
      reply: 'Entendido. En ese caso no te asigno a esa convocatoria. Si deseas, puedo dejar tu perfil registrado para futuras aperturas compatibles; solo avanzo con tus datos si me confirmas que quieres ese registro.'
    };
  }

  if (!intent.affirmative) return null;

  const vacancy = await loadVacancyById(prisma, alternativeMode.vacancyId);
  if (!vacancy || !isOpenVacancy(vacancy)) {
    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'ALTERNATIVE_VACANCY_NOT_AVAILABLE',
      replyKind: 'ALTERNATIVE_NOT_AVAILABLE_FUTURE_PROFILE_OFFER',
      candidateUpdates: {
        currentStep: GREETING_SENT,
        botResumeMode: FUTURE_PROFILE_OFFER_MODE,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      },
      reply: buildNoActiveVacanciesReply(vacancyCity(vacancy))
    };
  }

  return {
    action: VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE,
    reason: alternativeMode.kind === ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE
      ? 'ALTERNATIVE_PREQUALIFICATION_ACCEPTED'
      : 'ALTERNATIVE_VACANCY_ACCEPTED',
    vacancyId: vacancy.id,
    vacancy
  };
}

async function buildAlternativeDecision({ prisma, resolution = {}, vacancyHints = {}, inboundText = '', recentMessages = [] } = {}) {
  const city = resolution.city || vacancyHints?.city || null;
  const requestedRoleText = resolution.roleHint || vacancyHints?.roleHint || detectRoleHintFromText(inboundText, { city });
  if (!city || !requestedRoleText) return null;

  const activeVacancies = vacancyHints?.activeVacancies || await findActiveVacancies(prisma);
  const alternative = evaluateVacancyConceptAlternative({
    city,
    requestedRoleText,
    activeVacancies
  });

  if (alternative.action === VacancyConceptAlternativeAction.NONE) return null;

  const mode = alternative.action === VacancyConceptAlternativeAction.ASK_PREQUALIFICATION
    ? ALTERNATIVE_VACANCY_PREQUALIFICATION_MODE
    : ALTERNATIVE_VACANCY_OFFER_MODE;

  const decision = {
    action: VacancyFirstGateAction.REPLY,
    reason: alternative.reason,
    replyKind: alternative.action === VacancyConceptAlternativeAction.ASK_PREQUALIFICATION
      ? 'ALTERNATIVE_PREQUALIFICATION_PROMPT'
      : 'ALTERNATIVE_VACANCY_OFFER',
    candidateUpdates: {
      currentStep: GREETING_SENT,
      botResumeMode: buildAlternativeMode(mode, alternative.suggestedVacancyId),
      reminderScheduledFor: null,
      reminderState: 'SKIPPED'
    },
    reply: alternative.reply,
    resolution: {
      ...resolution,
      suggestedVacancyId: alternative.suggestedVacancyId,
      alternativeReason: alternative.reason
    }
  };

  return preventRepeatDecision(decision, { recentMessages, inboundText, city });
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
    return {
      action: VacancyFirstGateAction.SUPPRESS_REPLY,
      reason: 'RECENT_ATTACHMENT_GUIDANCE_ALREADY_SENT'
    };
  }

  const alternativeAcceptanceDecision = await evaluateAlternativeAcceptance({ prisma, candidate, inboundText });
  if (alternativeAcceptanceDecision) return alternativeAcceptanceDecision;

  if (isFutureProfileCaptureMode(botResumeMode)) {
    return {
      action: VacancyFirstGateAction.ALLOW_ENGINE,
      reason: 'FUTURE_PROFILE_CAPTURE_AUTHORIZED'
    };
  }

  const futureProfileConsent = evaluateFutureProfileConsent({ text: inboundText, botResumeMode, recentMessages });
  if (isFutureProfileOfferMode(botResumeMode) && futureProfileConsent.passiveAck) {
    return {
      action: VacancyFirstGateAction.SUPPRESS_REPLY,
      reason: 'PASSIVE_ACK_AFTER_FUTURE_PROFILE_OFFER',
      replyKind: futureProfileConsent.lastReplyKind || null
    };
  }

  if (isAlternativeOfferMode(botResumeMode)) {
    return {
      action: VacancyFirstGateAction.SUPPRESS_REPLY,
      reason: 'WAITING_FOR_ALTERNATIVE_DECISION',
      replyKind: 'ALTERNATIVE_VACANCY_OFFER'
    };
  }

  if (isRegisteredCompleteWithoutVacancy(candidate, effectiveReadiness)) {
    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'REGISTERED_COMPLETE_WITHOUT_VACANCY',
      replyKind: 'REGISTERED_PROFILE_CONTEXT',
      reply: buildRegisteredWithoutVacancyReply(candidate)
    };
  }

  if (currentVacancy || candidate?.vacancyId) {
    if (currentVacancy && !isOpenVacancy(currentVacancy)) {
      if (hasFutureProfileAcceptanceEvidence(inboundText, { botResumeMode, recentMessages })) {
        return {
          action: VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT,
          reason: 'PAUSED_VACANCY_FUTURE_PROFILE_ACCEPTED',
          replyKind: 'FUTURE_PROFILE_DATA_PROMPT',
          candidateUpdates: {
            currentStep: COLLECTING_DATA,
            botResumeMode: PAUSED_VACANCY_CAPTURE_MODE,
            reminderScheduledFor: null,
            reminderState: 'SKIPPED'
          },
          reply: missingDataPrompt(candidate, currentVacancy)
        };
      }
      return preventRepeatDecision({
        action: VacancyFirstGateAction.REPLY,
        reason: 'VACANCY_NOT_ACTIVE',
        replyKind: 'INACTIVE_VACANCY_FUTURE_PROFILE_OFFER',
        candidateUpdates: {
          currentStep: GREETING_SENT,
          botResumeMode: PAUSED_VACANCY_OFFER_MODE,
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        },
        reply: buildInactiveVacancyReply(currentVacancy)
      }, { recentMessages, inboundText, city: vacancyCity(currentVacancy) });
    }

    return {
      action: VacancyFirstGateAction.ALLOW_ENGINE,
      reason: 'ACTIVE_VACANCY_ALREADY_RESOLVED'
    };
  }

  if (!START_OR_INTAKE_STEPS.has(currentStep)) {
    return {
      action: VacancyFirstGateAction.ALLOW_ENGINE,
      reason: 'STEP_OUTSIDE_VACANCY_FIRST_INTAKE'
    };
  }

  if (hasFutureProfileAcceptanceEvidence(inboundText, { botResumeMode, recentMessages })) {
    return {
      action: VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT,
      reason: 'NO_ACTIVE_VACANCY_FUTURE_PROFILE_ACCEPTED',
      replyKind: 'FUTURE_PROFILE_DATA_PROMPT',
      candidateUpdates: {
        currentStep: COLLECTING_DATA,
        botResumeMode: FUTURE_PROFILE_CAPTURE_MODE,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      },
      reply: missingDataPrompt(candidate, null)
    };
  }

  const resolutionText = buildResolutionText(inboundText, recentMessages);
  const resolution = await resolveVacancyFromText(prisma, resolutionText || inboundText, {
    cityHint: vacancyHints?.city || null,
    roleHint: vacancyHints?.roleHint || null,
    allVacancies: vacancyHints?.allVacancies,
    activeVacancies: vacancyHints?.activeVacancies
  });

  if (resolution.resolved && resolution.vacancy && isOpenVacancy(resolution.vacancy)) {
    return {
      action: VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE,
      reason: 'ACTIVE_VACANCY_RESOLVED',
      vacancyId: resolution.vacancy.id,
      vacancy: resolution.vacancy,
      resolution
    };
  }

  if (resolution.resolved && resolution.vacancy && !isOpenVacancy(resolution.vacancy)) {
    return preventRepeatDecision({
      action: VacancyFirstGateAction.INACTIVE_VACANCY_REPLY,
      reason: 'INACTIVE_VACANCY_RESOLVED',
      replyKind: 'INACTIVE_VACANCY_FUTURE_PROFILE_OFFER',
      vacancy: resolution.vacancy,
      candidateUpdates: {
        currentStep: GREETING_SENT,
        botResumeMode: PAUSED_VACANCY_OFFER_MODE,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      },
      reply: buildInactiveVacancyReply(resolution.vacancy, resolution.city),
      resolution
    }, { recentMessages, inboundText, city: resolution.city });
  }

  if (['city_without_active_vacancies', 'no_active_vacancies'].includes(resolution.reason)) {
    return preventRepeatDecision({
      action: VacancyFirstGateAction.REPLY,
      reason: 'CITY_WITHOUT_ACTIVE_VACANCIES',
      replyKind: 'NO_ACTIVE_VACANCIES_FOR_CITY',
      candidateUpdates: {
        currentStep: GREETING_SENT,
        botResumeMode: FUTURE_PROFILE_OFFER_MODE,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      },
      reply: buildNoActiveVacanciesReply(resolution.city),
      resolution
    }, { recentMessages, inboundText, city: resolution.city });
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
    }, { recentMessages, inboundText, city: resolution.city });
  }

  return preventRepeatDecision({
    action: VacancyFirstGateAction.REPLY,
    reason: 'VACANCY_NOT_RESOLVED',
    replyKind: 'ASK_CITY_AND_ROLE',
    candidateUpdates: { currentStep: GREETING_SENT },
    reply: 'Hola, gracias por comunicarte con LoginPro. ¿Desde qué ciudad nos escribes y para qué vacante?',
    resolution
  }, { recentMessages, inboundText, city: resolution?.city });
}
