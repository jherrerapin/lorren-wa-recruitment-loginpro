import { ConversationStep } from '@prisma/client';
import { think, act, extractEngineCandidateFields, hasRecentHumanIntervention } from './conversationEngine.js';
import { sanitizeCandidateFieldsForConversation } from './fieldSanitizer.js';
import { sanitizeOutboundReply } from './replySafety.js';
import { buildMissingFieldReply, getCandidateReadiness } from './readinessGuard.js';
import { detectConversationIntent } from './conversationIntent.js';
import { evaluateContextualResponseGate, inferContextualSemanticIntent, ContextualAllowedAction } from './contextualResponseGate.js';

const PAUSED_VACANCY_FLAG = 'paused_vacancy';
const PAUSED_VACANCY_CAPTURE = 'paused_vacancy_capture';

function isOpenVacancy(vacancy = null) {
  return Boolean(vacancy?.isActive && vacancy?.acceptingApplications);
}

function pausedVacancyMessage(vacancy = null) {
  const role = vacancy?.title || vacancy?.role || 'esa vacante';
  const city = vacancy?.operation?.city?.name || vacancy?.city || '';
  const place = city ? ` en ${city}` : '';
  return `La convocatoria de ${role}${place} está identificada, pero por ahora no está activa. Si deseas, puedo tomar tu registro para futuras aperturas.`;
}

function pausedRegistrationMessage(candidate = {}, vacancy = null) {
  const readiness = getCandidateReadiness(candidate, vacancy, { requireCv: false });
  const labels = readiness.missingFieldLabels || readiness.missingFields || [];
  if (labels.length) return `Listo, lo tomo como registro para futuras aperturas. Compárteme: ${labels.join(', ')}.`;
  return 'Listo, lo tomo como registro para futuras aperturas. Si no la has enviado, adjunta tu hoja de vida en PDF o Word/DOCX.';
}

function buildBypassResult({ reply, nextStep, reason }) {
  return {
    reply,
    actions: [],
    nextStep,
    extractedFields: {},
    candidateFields: {},
    fallback: false,
    fallbackReason: null,
    loopGuardApplied: false,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    suppressed: false,
    suppressedReason: null,
    pausedVacancyGuard: reason
  };
}

async function guardPausedVacancy({ prisma, candidate, vacancy, inboundText, currentStep }) {
  if (!vacancy || isOpenVacancy(vacancy)) return null;
  if (candidate?.botResumeMode === PAUSED_VACANCY_CAPTURE) return null;

  const intent = detectConversationIntent(inboundText, { currentStep });
  const waiting = candidate?.botResumeMode === PAUSED_VACANCY_FLAG;

  if (waiting && (intent === 'confirmation_yes' || intent === 'apply_intent' || intent === 'cv_intent')) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.COLLECTING_DATA,
        botResumeMode: PAUSED_VACANCY_CAPTURE,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });

    return buildBypassResult({
      reply: pausedRegistrationMessage(candidate, vacancy),
      nextStep: ConversationStep.COLLECTING_DATA,
      reason: 'accepted'
    });
  }

  if (waiting && (intent === 'no_interest' || intent === 'farewell')) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.DONE,
        botResumeMode: null,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });

    return buildBypassResult({
      reply: 'Entendido, gracias por escribirnos. Puedes volver a escribirnos más adelante para revisar nuevas aperturas.',
      nextStep: ConversationStep.DONE,
      reason: 'declined'
    });
  }

  await prisma.candidate.update({
    where: { id: candidate.id },
    data: {
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: PAUSED_VACANCY_FLAG,
      reminderScheduledFor: null,
      reminderState: 'SKIPPED'
    }
  });

  return buildBypassResult({
    reply: pausedVacancyMessage(vacancy),
    nextStep: ConversationStep.GREETING_SENT,
    reason: waiting ? 'waiting' : 'requested'
  });
}

function latestOutboundWasManualHumanWithoutLaterInbound(recentMessages = []) {
  const messages = recentMessages || [];
  const lastOutboundIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find((entry) => entry.message?.direction === 'OUTBOUND')?.index;

  if (lastOutboundIndex === undefined) return false;
  const lastOutbound = messages[lastOutboundIndex];
  if (!hasRecentHumanIntervention([lastOutbound])) return false;

  return !messages.slice(lastOutboundIndex + 1).some((message) => message?.direction === 'INBOUND');
}

/**
 * chatEngine.js
 *
 * Orquesta el engine de conversación LLM:
 *  - Llama a think() para obtener reply/nextStep/actions.
 *  - Ejecuta act() para aplicar efectos secundarios (Prisma, scheduler).
 *  - Devuelve solo el texto de respuesta para enviarlo por WhatsApp.
 */
export async function runChatEngine({
  prisma,
  candidate,
  vacancy,
  inboundText,
  recentMessages,
  nextSlot = null,
  candidateFieldHints = {},
}) {
  const currentStep = candidate.currentStep || ConversationStep.MENU;
  const activeInterviewBooking = nextSlot?.isConfirmedBooking
    ? { status: 'SCHEDULED', scheduledAt: nextSlot.date }
    : null;
  const pausedGuard = await guardPausedVacancy({ prisma, candidate, vacancy, inboundText, currentStep });
  if (pausedGuard) return pausedGuard;

  const readiness = getCandidateReadiness(candidate, vacancy);
  const shouldEvaluateGate = Boolean(
    currentStep === ConversationStep.SCHEDULED
    || currentStep === ConversationStep.DONE
    || (vacancy && !vacancy.schedulingEnabled && readiness.readyForDone)
  );

  if (shouldEvaluateGate) {
    const resolvedIntent = detectConversationIntent(inboundText, {
      currentStep,
      isDoneStep: currentStep === ConversationStep.DONE
    });
    const semanticIntent = inferContextualSemanticIntent({
      text: inboundText,
      resolvedIntent,
      isQuestion: /[?¿]/.test(String(inboundText || '')),
      hasDataIntent: resolvedIntent === 'provide_data'
    });
    const gateDecision = evaluateContextualResponseGate({
      candidate,
      vacancy,
      activeInterviewBooking,
      recentMessages,
      semanticIntent,
      readiness
    });

    if (gateDecision.allowedAction !== ContextualAllowedAction.CONTINUE_FLOW) {
      return {
        reply: gateDecision.reply,
        actions: [],
        nextStep: currentStep,
        extractedFields: {},
        candidateFields: {},
        fallback: false,
        fallbackReason: null,
        loopGuardApplied: false,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        suppressed: !gateDecision.shouldReply,
        suppressedReason: gateDecision.shouldReply ? null : gateDecision.reason,
        contextualGate: gateDecision
      };
    }
  }

  if (!candidate.botPaused && latestOutboundWasManualHumanWithoutLaterInbound(recentMessages)) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        botPaused: true,
        botPausedAt: new Date(),
        botPauseReason: 'Intervencion humana detectada en el chat',
        botResumeMode: 'awaiting_inbound_after_human_intervention',
        reminderScheduledFor: null,
        reminderState: 'CANCELLED'
      }
    });

    console.warn('[BOT_PAUSED]', JSON.stringify({ candidateId: candidate.id, reason: 'manual_human_outbound_detected' }));

    return {
      reply: null,
      actions: [],
      nextStep: currentStep,
      extractedFields: {},
      candidateFields: {},
      fallback: false,
      fallbackReason: null,
      loopGuardApplied: false,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      suppressed: true,
      suppressedReason: 'manual_human_outbound_detected',
    };
  }

  const result = await think({
    inboundText,
    candidate,
    vacancy,
    recentMessages,
    nextSlot,
    currentStep,
    prisma,
  });

  const actions = Array.isArray(result.actions) ? result.actions : [];
  const extractedFields = result.extractedFields && typeof result.extractedFields === 'object'
    ? result.extractedFields
    : {};
  const engineCandidateFields = extractEngineCandidateFields(actions, extractedFields);
  const candidateFields = {
    ...(candidateFieldHints && typeof candidateFieldHints === 'object' ? candidateFieldHints : {}),
    ...engineCandidateFields
  };
  const engineEvidence = Object.fromEntries(
    Object.keys(candidateFields).map((field) => [
      field,
      { snippet: String(inboundText || '').slice(0, 180), confidence: 0.78, source: 'engine' }
    ])
  );
  const sanitized = sanitizeCandidateFieldsForConversation({
    fields: candidateFields,
    evidence: engineEvidence,
    text: inboundText,
    context: { currentStep },
    turnType: null
  });

  const actResult = await act({
    actions,
    candidate,
    extractedFields: sanitized.fields,
    candidateFields: sanitized.fields,
    nextStep: result.nextStep,
    nextSlot,
    vacancy,
    prisma,
  });

  const guardedReply = actResult?.blockedActions?.length
    ? buildMissingFieldReply(actResult.readiness)
    : result.reply;

  const safeReply = sanitizeOutboundReply({
    reply: guardedReply,
    vacancy,
    candidate,
    currentStep,
    source: 'engine'
  });
  const hasSilentManualPause = !String(safeReply.reply || '').trim()
    && actions.some((action) => action?.type === 'pause_bot');
  const noUsefulReply = !String(safeReply.reply || '').trim()
    && actions.length
    && (hasSilentManualPause || actions.every((action) => action?.type === 'nothing'));

  return {
    reply: safeReply.reply,
    actions,
    nextStep: result.nextStep,
    extractedFields: sanitized.fields,
    candidateFields: sanitized.fields,
    rejectedFields: sanitized.rejectedFields,
    replySafety: safeReply,
    readiness: actResult?.readiness || null,
    blockedActions: actResult?.blockedActions || [],
    fallback: result.fallback,
    fallbackReason: result.fallbackReason || null,
    loopGuardApplied: Boolean(result.loopGuardApplied),
    usage: result.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    suppressed: noUsefulReply,
    suppressedReason: noUsefulReply
      ? (hasSilentManualPause ? 'engine_pause_bot_no_reply' : 'engine_nothing_no_reply')
      : null,
  };
}
