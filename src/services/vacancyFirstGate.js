import { getCandidateReadiness, hasValidCv } from './readinessGuard.js';
import { normalizeResolverText, resolveVacancyFromText } from './vacancyResolver.js';

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

function buildNeedRoleForCityReply(city = null) {
  const place = city ? ` en ${city}` : 'en tu ciudad';
  const localityPart = isBogotaCity(city) ? ' y en qué localidad estás' : '';
  return `Gracias por contarme desde dónde escribes. Para ubicar una convocatoria real ${place} sin asumir una vacante, cuéntame qué cargo o vacante buscas${localityPart}.`;
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

function hasFutureProfileAcceptanceEvidence(text = '') {
  const normalized = normalizeResolverText(text);
  if (!normalized) return false;
  const tokens = new Set(normalized.split(' ').filter(Boolean));
  const affirmative = ['si', 'sii', 'sip', 'sipi', 'claro', 'listo', 'acepto', 'confirmo', 'dale'].some((token) => tokens.has(token));
  const profileIntent = /\b(dejar|registr|guardar|tomar|enviar|adjuntar|mandar|compartir)\b/.test(normalized)
    && /\b(perfil|hoja de vida|hv|datos|registro|registrada|registrado)\b/.test(normalized);
  return affirmative && profileIntent;
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

  if (isFutureProfileCaptureMode(botResumeMode)) {
    return {
      action: VacancyFirstGateAction.ALLOW_ENGINE,
      reason: 'FUTURE_PROFILE_CAPTURE_AUTHORIZED'
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
      if (isFutureProfileOfferMode(botResumeMode) && hasFutureProfileAcceptanceEvidence(inboundText)) {
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
      return {
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
      };
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

  if (isFutureProfileOfferMode(botResumeMode) && hasFutureProfileAcceptanceEvidence(inboundText)) {
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
    return {
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
    };
  }

  if (['city_without_active_vacancies', 'no_active_vacancies'].includes(resolution.reason)) {
    return {
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
    };
  }

  if (['city_with_active_vacancies', 'ambiguous_match', 'low_confidence_match'].includes(resolution.reason) && resolution.city) {
    return {
      action: VacancyFirstGateAction.REPLY,
      reason: 'CITY_WITH_ACTIVE_VACANCIES_ROLE_AMBIGUOUS',
      replyKind: 'ASK_CITY_LOCALITY_AND_ROLE',
      candidateUpdates: { currentStep: GREETING_SENT },
      reply: buildNeedRoleForCityReply(resolution.city),
      resolution
    };
  }

  return {
    action: VacancyFirstGateAction.REPLY,
    reason: 'VACANCY_NOT_RESOLVED',
    replyKind: 'ASK_CITY_AND_ROLE',
    candidateUpdates: { currentStep: GREETING_SENT },
    reply: 'Con gusto te ayudo. Para revisar una convocatoria real y no asumir una vacante, cuéntame desde qué ciudad nos escribes y qué cargo o vacante buscas.',
    resolution
  };
}
