import { getCandidateReadiness } from './readinessGuard.js';
import { formatInterviewDate } from './interviewScheduler.js';
import { buildInterviewDocumentsSentence, sanitizeRequiredDocumentsForBot } from './naturalReply.js';
import { classifyOutboundActor, inferOutboundActorFromSource, isManualOutboundSource } from './manualSourcePolicy.js';

export const ContextualAllowedAction = Object.freeze({
  CONTINUE_FLOW: 'CONTINUE_FLOW',
  NO_REPLY: 'NO_REPLY',
  SHORT_CONTEXTUAL_CLOSE: 'SHORT_CONTEXTUAL_CLOSE',
  ANSWER_FROM_ASSIGNED_CONTEXT: 'ANSWER_FROM_ASSIGNED_CONTEXT',
  CREATE_INTERNAL_REVIEW_AND_SAFE_REPLY: 'CREATE_INTERNAL_REVIEW_AND_SAFE_REPLY',
  ASK_VACANCY_CONFIRMATION: 'ASK_VACANCY_CONFIRMATION'
});

export const ContextualResponsePurpose = Object.freeze({
  NONE: 'NONE',
  CLOSE_THREAD: 'CLOSE_THREAD',
  LOGISTICS_ANSWER: 'LOGISTICS_ANSWER',
  SAFE_INFORMATION_GAP: 'SAFE_INFORMATION_GAP',
  VACANCY_RESOLUTION: 'VACANCY_RESOLUTION',
  FLOW: 'FLOW'
});

const CLOSING_INTENTS = new Set(['ACKNOWLEDGEMENT', 'SOFT_CONFIRMATION', 'POST_COMPLETION_ACK', 'THANKS', 'FAREWELL']);
const ACTIVE_BOOKING_STATUSES = new Set(['SCHEDULED', 'CONFIRMED']);
const LOGISTIC_INTENTS = new Set([
  'ASK_INTERVIEW_ADDRESS',
  'ASK_INTERVIEW_TIME',
  'ASK_INTERVIEW_CONTACT_PERSON',
  'ASK_REQUIRED_DOCUMENTS'
]);
const APPOINTMENT_MANUAL_REVIEW_INTENTS = new Set([
  'REPORT_ARRIVAL_PROBLEM'
]);
const APPOINTMENT_ACTION_INTENTS = new Set([
  'CONFIRM_ATTENDANCE',
  'CANCEL_ATTENDANCE',
  'REQUEST_RESCHEDULE',
  'SEND_CV'
]);

function normalize(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decision({
  shouldReply = false,
  allowedAction = ContextualAllowedAction.NO_REPLY,
  reason,
  responsePurpose = ContextualResponsePurpose.NONE,
  stateUpdates = {},
  requiresHumanReview = false,
  reply = null,
  metadata = {}
}) {
  return { shouldReply, allowedAction, reason, responsePurpose, stateUpdates, requiresHumanReview, reply, metadata };
}

function safeReviewDecision(reason, semanticIntent = 'UNCLEAR') {
  return decision({
    shouldReply: true,
    allowedAction: ContextualAllowedAction.CREATE_INTERNAL_REVIEW_AND_SAFE_REPLY,
    reason,
    responsePurpose: ContextualResponsePurpose.SAFE_INFORMATION_GAP,
    requiresHumanReview: true,
    reply: buildSafeInformationGapReply(semanticIntent)
  });
}

export function getLastOutboundContext(recentMessages = []) {
  const lastOutbound = [...(recentMessages || [])]
    .reverse()
    .find((message) => message?.direction === 'OUTBOUND');
  if (!lastOutbound) {
    return { actor: null, source: null, purpose: null, message: null, isManual: false };
  }
  const rawPayload = lastOutbound.rawPayload || {};
  const classification = classifyOutboundActor(rawPayload);
  return {
    actor: classification.actor,
    source: classification.source,
    purpose: rawPayload.responsePurpose || rawPayload.purpose || rawPayload.situation || null,
    message: lastOutbound,
    isManual: classification.isManual
  };
}

export { inferOutboundActorFromSource as inferActorFromSource, isManualOutboundSource };

function hasActiveBooking(booking = null) {
  return Boolean(booking && ACTIVE_BOOKING_STATUSES.has(booking.status));
}

function hasAssignedVacancy(candidate = {}, vacancy = null) {
  return Boolean(candidate?.vacancyId || vacancy?.id);
}

function isMainFlowComplete(candidate = {}, vacancy = null, readiness = null) {
  const resolvedReadiness = readiness || getCandidateReadiness(candidate, vacancy);
  return Boolean(
    resolvedReadiness.readyForDone
    || (candidate.currentStep === 'DONE' && resolvedReadiness.coreDataComplete && resolvedReadiness.hasValidCv)
  );
}

function isCvOnlyComplete(candidate = {}, vacancy = null, readiness = null) {
  if (!vacancy || vacancy.schedulingEnabled) return false;
  return isMainFlowComplete(candidate, vacancy, readiness);
}

function getConfiguredContactPerson({ vacancy = null, activeInterviewBooking = null } = {}) {
  return activeInterviewBooking?.contactPerson
    || activeInterviewBooking?.contactName
    || vacancy?.interviewContactPerson
    || vacancy?.contactPerson
    || vacancy?.interviewContact
    || null;
}

function getConfiguredInterviewAddress({ vacancy = null, activeInterviewBooking = null } = {}) {
  return activeInterviewBooking?.address
    || activeInterviewBooking?.interviewAddress
    || vacancy?.interviewAddress
    || vacancy?.operationAddress
    || null;
}

function buildLogisticsReply({ semanticIntent, vacancy = null, activeInterviewBooking = null } = {}) {
  if (semanticIntent === 'ASK_INTERVIEW_CONTACT_PERSON') {
    const contactPerson = getConfiguredContactPerson({ vacancy, activeInterviewBooking });
    if (!contactPerson) return null;
    return `Al llegar, pregunta por ${contactPerson}.`;
  }

  if (semanticIntent === 'ASK_INTERVIEW_ADDRESS') {
    const address = getConfiguredInterviewAddress({ vacancy, activeInterviewBooking });
    if (!address) return null;
    return `La dirección registrada para tu entrevista es ${address}.`;
  }

  if (semanticIntent === 'ASK_INTERVIEW_TIME') {
    if (!activeInterviewBooking?.scheduledAt) return null;
    return `Tu entrevista está registrada para ${formatInterviewDate(new Date(activeInterviewBooking.scheduledAt))}.`;
  }

  if (semanticIntent === 'ASK_INTERVIEW_AVAILABILITY') {
    return null;
  }

  if (semanticIntent === 'ASK_REQUIRED_DOCUMENTS') {
    const documents = sanitizeRequiredDocumentsForBot(vacancy?.requiredDocuments || '');
    if (!documents) return null;
    return buildInterviewDocumentsSentence(documents);
  }

  return null;
}

function buildApplicationStatusReply({ candidate = {}, vacancy = null, activeInterviewBooking = null } = {}) {
  if (activeInterviewBooking?.scheduledAt) {
    return `Tu entrevista sigue registrada para ${formatInterviewDate(new Date(activeInterviewBooking.scheduledAt))}. Si hay algún cambio, te lo informaremos por este medio.`;
  }
  if (candidate.currentStep === 'DONE' || ['REGISTRADO', 'VALIDANDO', 'APROBADO', 'CONTACTADO', 'CONTRATADO'].includes(String(candidate.status || ''))) {
    return 'Tu postulación continúa registrada. El equipo de selección revisará el proceso y te contactará por este medio si hay una novedad.';
  }
  if (vacancy?.title || vacancy?.role) {
    return `Tu proceso sigue asociado a la vacante de ${vacancy.title || vacancy.role}. Continuaremos desde el punto pendiente de tu registro.`;
  }
  return 'Tu proceso sigue registrado. Continuaremos desde el punto pendiente y te contactaremos por este medio si hay una novedad.';
}

export function buildSafeInformationGapReply(semanticIntent = 'UNCLEAR') {
  if (semanticIntent === 'ASK_INTERVIEW_CONTACT_PERSON') {
    return 'Gracias por preguntar. Tengo registrada tu entrevista, pero no tengo confirmado el nombre de la persona que te recibirá. Conserva la hora y dirección que ya tienes registradas.';
  }
  if (semanticIntent === 'ASK_INTERVIEW_ADDRESS') {
    return 'Gracias por preguntar. Tengo registrada tu entrevista, pero la dirección exacta no está confirmada en la información disponible.';
  }
  if (semanticIntent === 'ASK_REQUIRED_DOCUMENTS') {
    return 'Gracias por preguntar. Por ahora no tengo documentos adicionales confirmados en la información de la vacante.';
  }
  if (semanticIntent === 'ASK_INTERVIEW_AVAILABILITY') {
    return 'Gracias por preguntar. Tengo registrada tu entrevista, pero no tengo confirmados horarios adicionales en la información disponible.';
  }
  return 'Gracias por escribir. Ya tengo el contexto de tu proceso registrado y no veo un dato adicional confirmado para responderte con precisión.';
}

export function inferContextualSemanticIntent({
  text = '',
  resolvedIntent = null,
  interviewIntent = null,
  isQuestion = false,
  hasCvAttachment = false,
  hasDataIntent = false
} = {}) {
  if (interviewIntent === 'confirm_attendance') return 'CONFIRM_ATTENDANCE';
  if (interviewIntent === 'cancel_interview') return 'CANCEL_ATTENDANCE';
  if (interviewIntent === 'reschedule_interview') return 'REQUEST_RESCHEDULE';
  if (hasCvAttachment || resolvedIntent === 'cv_intent') return 'SEND_CV';
  if (['post_completion_ack', 'thanks', 'farewell'].includes(resolvedIntent)) return resolvedIntent === 'farewell' ? 'FAREWELL' : 'ACKNOWLEDGEMENT';
  const normalized = normalize(text);
  if (/\b(me\s+perdi|estoy\s+perdid[oa]|me\s+desubique|no\s+conozco|transbord|inconveniente|me\s+demor[eo]|voy\s+tarde|llego\s+tarde|retrasad[oa]|no\s+alcanzo|se\s+me\s+hizo\s+tarde)\b/.test(normalized)) return 'REPORT_ARRIVAL_PROBLEM';
  if (resolvedIntent === 'confirmation_yes') return 'SOFT_CONFIRMATION';
  if (hasDataIntent) return 'PROVIDE_EXTRA_DATA';

  if (isQuestion || resolvedIntent === 'faq' || resolvedIntent === 'info_request') {
    const hasInterviewTopic = /\b(entrevist\w*|cita|presentar|llegar|asistir|ir)\b/.test(normalized);
    if (/\b(direccion|ubicacion|donde|queda|lugar|sede)\b/.test(normalized) && hasInterviewTopic) return 'ASK_INTERVIEW_ADDRESS';
    if (/\b(hora|horario|cuando|fecha|dia)\b/.test(normalized) && hasInterviewTopic) return 'ASK_INTERVIEW_TIME';
    if (/\b(quien|persona|contacto|preguntar|recibe|recepcion)\b/.test(normalized) && hasInterviewTopic) return 'ASK_INTERVIEW_CONTACT_PERSON';
    if (/\b(document|llevar)\b/.test(normalized) && hasInterviewTopic) return 'ASK_REQUIRED_DOCUMENTS';
    if (/\b(vacante|oferta|convocatoria|cargo|funcion|funciones|labor|requisit|salario|sueldo|pago|contrato|beneficio|condiciones|experiencia|zona|sector)\b/.test(normalized)) return 'ASK_VACANCY_INFORMATION';
    return 'ASK_APPLICATION_STATUS';
  }

  if (resolvedIntent === 'greeting') return 'SOFT_CONFIRMATION';
  if (resolvedIntent === 'already_sent') return 'SOFT_CONFIRMATION';
  if (resolvedIntent === 'unsupported_file_or_message') return 'UNCLEAR';
  return 'UNCLEAR';
}

export function evaluateContextualResponseGate({
  candidate = {},
  vacancy = null,
  activeInterviewBooking = null,
  recentMessages = [],
  semanticIntent = 'UNCLEAR',
  readiness = null,
  hasPendingAction = null
} = {}) {
  const resolvedReadiness = readiness || getCandidateReadiness(candidate, vacancy);
  const lastOutbound = getLastOutboundContext(recentMessages);
  const activeBooking = hasActiveBooking(activeInterviewBooking) ? activeInterviewBooking : null;
  const vacancyAssigned = hasAssignedVacancy(candidate, vacancy);
  const realPendingAction = hasPendingAction ?? Boolean(
    !vacancyAssigned
    || resolvedReadiness.missingFields?.length
    || (!resolvedReadiness.hasValidCv && candidate.currentStep === 'ASK_CV')
    || candidate.currentStep === 'SCHEDULING'
  );

  if (!vacancyAssigned && !['ASK_APPLICATION_STATUS', 'PROVIDE_EXTRA_DATA'].includes(semanticIntent)) {
    return decision({
      shouldReply: true,
      allowedAction: ContextualAllowedAction.ASK_VACANCY_CONFIRMATION,
      reason: 'No vacancy is assigned with enough confidence; main flow actions are blocked until vacancy resolution.',
      responsePurpose: ContextualResponsePurpose.VACANCY_RESOLUTION
    });
  }

  if (lastOutbound.isManual && !realPendingAction && ['ASK_APPLICATION_STATUS', 'PROVIDE_EXTRA_DATA', 'UNCLEAR', 'SOFT_CONFIRMATION'].includes(semanticIntent)) {
    return decision({
      shouldReply: false,
      allowedAction: ContextualAllowedAction.NO_REPLY,
      reason: 'Last outbound message was manually authorized and no deterministic pending action exists; suppressing bot reply to avoid overriding recruiter context.',
      responsePurpose: ContextualResponsePurpose.NONE
    });
  }

  if (lastOutbound.isManual && CLOSING_INTENTS.has(semanticIntent) && !realPendingAction) {
    return decision({
      shouldReply: false,
      allowedAction: ContextualAllowedAction.NO_REPLY,
      reason: 'Last outbound message was manually authorized by a recruiter and the new candidate message is a contextual closing message with no real pending action.',
      responsePurpose: ContextualResponsePurpose.NONE
    });
  }

  if (activeBooking && candidate.currentStep === 'SCHEDULED') {
    if (semanticIntent === 'ASK_INTERVIEW_AVAILABILITY') {
      return safeReviewDecision(
        'Candidate asked about interview slot availability beyond the confirmed appointment; this requires human validation before replying.',
        semanticIntent
      );
    }

    if (semanticIntent === 'ASK_APPLICATION_STATUS') {
      return decision({
        shouldReply: true,
        allowedAction: ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT,
        reason: 'Candidate asked for process status and the active appointment provides an authoritative answer.',
        responsePurpose: ContextualResponsePurpose.LOGISTICS_ANSWER,
        requiresHumanReview: false,
        reply: buildApplicationStatusReply({ candidate, vacancy, activeInterviewBooking: activeBooking })
      });
    }

    if (semanticIntent === 'ASK_VACANCY_INFORMATION') {
      return decision({
        shouldReply: true,
        allowedAction: ContextualAllowedAction.CONTINUE_FLOW,
        reason: 'Candidate asked an ordinary vacancy question; continue to the vacancy context responder before considering human review.',
        responsePurpose: ContextualResponsePurpose.FLOW
      });
    }

    if (APPOINTMENT_MANUAL_REVIEW_INTENTS.has(semanticIntent)) {
      return safeReviewDecision(
        'Candidate has an active appointment and reported an arrival issue that is not answerable from the assigned vacancy or appointment context; this requires human validation before replying.',
        semanticIntent
      );
    }

    if (LOGISTIC_INTENTS.has(semanticIntent)) {
      const reply = buildLogisticsReply({ semanticIntent, vacancy, activeInterviewBooking: activeBooking });
      if (reply) {
        return decision({
          shouldReply: true,
          allowedAction: ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT,
          reason: 'Candidate has an active appointment and asked a permitted logistics question answerable from assigned vacancy or appointment data.',
          responsePurpose: ContextualResponsePurpose.LOGISTICS_ANSWER,
          reply
        });
      }
      return decision({
        shouldReply: true,
        allowedAction: ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT,
        reason: 'Candidate asked for a non-critical logistics fact that is not configured; answer the information gap safely without automatic handoff.',
        responsePurpose: ContextualResponsePurpose.SAFE_INFORMATION_GAP,
        requiresHumanReview: false,
        reply: buildSafeInformationGapReply(semanticIntent)
      });
    }

    if (APPOINTMENT_ACTION_INTENTS.has(semanticIntent)) {
      return decision({
        shouldReply: true,
        allowedAction: ContextualAllowedAction.CONTINUE_FLOW,
        reason: 'Candidate has an active appointment and the message maps to an allowed appointment action.',
        responsePurpose: ContextualResponsePurpose.FLOW
      });
    }

    if (CLOSING_INTENTS.has(semanticIntent) || !realPendingAction) {
      return decision({
        shouldReply: false,
        allowedAction: ContextualAllowedAction.NO_REPLY,
        reason: 'Candidate already has an active appointment and the message does not require a permitted bot action.',
        responsePurpose: ContextualResponsePurpose.NONE
      });
    }
  }

  if ((isCvOnlyComplete(candidate, vacancy, resolvedReadiness) || isMainFlowComplete(candidate, vacancy, resolvedReadiness)) && !realPendingAction) {
    if (CLOSING_INTENTS.has(semanticIntent)) {
      return decision({
        shouldReply: false,
        allowedAction: ContextualAllowedAction.NO_REPLY,
        reason: 'Candidate main flow is complete and the new message is only contextual closure.',
        responsePurpose: ContextualResponsePurpose.NONE
      });
    }
    if (['ASK_APPLICATION_STATUS', 'ASK_VACANCY_INFORMATION', 'PROVIDE_EXTRA_DATA', 'UNCLEAR'].includes(semanticIntent)) {
      return decision({
        shouldReply: true,
        allowedAction: ContextualAllowedAction.CONTINUE_FLOW,
        reason: 'Candidate main flow is complete, but the new message may need a contextual answer or correction; continue to the engine instead of returning a fixed close.',
        responsePurpose: ContextualResponsePurpose.FLOW,
        metadata: { postCompletionContext: true }
      });
    }
    return decision({
      shouldReply: false,
      allowedAction: ContextualAllowedAction.NO_REPLY,
      reason: 'Candidate has no real pending action; suppressing automatic flow continuation.',
      responsePurpose: ContextualResponsePurpose.NONE
    });
  }

  return decision({
    shouldReply: true,
    allowedAction: ContextualAllowedAction.CONTINUE_FLOW,
    reason: 'A real pending action exists or the candidate is in an active collection/scheduling state.',
    responsePurpose: ContextualResponsePurpose.FLOW
  });
}
