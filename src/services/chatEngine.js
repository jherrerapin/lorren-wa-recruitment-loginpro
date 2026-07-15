import axios from 'axios';
import { ConversationStep } from '@prisma/client';
import { think, act, extractEngineCandidateFields, hasRecentHumanIntervention } from './conversationEngine.js';
import { getNextAvailableSlotAfter, formatInterviewDate } from './interviewScheduler.js';
import { applyInterviewReminderResponse } from './interviewBookingStateService.js';
import { sanitizeCandidateFieldsForConversation } from './fieldSanitizer.js';
import { guardReplyAgainstReadinessDrift, sanitizeOutboundReply } from './replySafety.js';
import { buildMissingFieldReply, getCandidateReadiness } from './readinessGuard.js';
import { detectConversationIntent } from './conversationIntent.js';
import { classifyInterviewIntent } from './interviewIntentClassifier.js';
import { evaluateContextualResponseGate, inferContextualSemanticIntent, ContextualAllowedAction } from './contextualResponseGate.js';
import { OPENAI_EXTRACTION_MODEL } from './openAiModelConfig.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const PAUSED_VACANCY_FLAG = 'paused_vacancy';
const PAUSED_VACANCY_CAPTURE = 'paused_vacancy_capture';

const COMPLETION_REPLY = 'Tu información y hoja de vida quedaron registradas correctamente. El equipo de selección revisará tu perfil y, si el proceso continúa, te contactará por este medio.';

function buildDeterministicProgressReply(actResult = {}) {
  if (actResult?.finalStep === ConversationStep.DONE && actResult?.readiness?.readyForDone) {
    return COMPLETION_REPLY;
  }
  return null;
}

const CONSENT_MODEL = OPENAI_EXTRACTION_MODEL;
const APPOINTMENT_ACTION_INTENTS = new Set([
  'confirm_attendance',
  'cancel_interview',
  'reschedule_interview'
]);

const PAUSED_CONSENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'confidence', 'evidence', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['accept', 'decline', 'ambiguous'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'string' },
    reason: { type: 'string' }
  }
};

function parseStructuredOutput(data = {}) {
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.parsed && typeof part.parsed === 'object') return part.parsed;
      if (typeof part?.text === 'string') {
        try { return JSON.parse(part.text); } catch {}
      }
    }
  }
  return null;
}

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

function buildBypassResult({ reply, nextStep, reason, consent = null }) {
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
    pausedVacancyGuard: reason,
    pausedVacancyConsent: consent
  };
}

function buildEngineHandledResult({ reply, currentStep, intent, classification }) {
  return {
    reply,
    actions: [{ type: 'interview_reminder_response', data: { intent, source: classification?.source || null } }],
    nextStep: currentStep,
    extractedFields: {},
    candidateFields: {},
    fallback: false,
    fallbackReason: null,
    loopGuardApplied: false,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    suppressed: false,
    suppressedReason: null,
    handledInterviewIntent: intent,
    interviewIntentClassification: classification || null
  };
}

async function loadActiveInterviewBooking(prisma, candidateId) {
  if (!candidateId || typeof prisma?.interviewBooking?.findFirst !== 'function') return null;
  return prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      status: { in: ['SCHEDULED', 'CONFIRMED'] }
    },
    orderBy: { scheduledAt: 'asc' },
    select: {
      id: true,
      candidateId: true,
      vacancyId: true,
      slotId: true,
      scheduledAt: true,
      status: true,
      reminderSentAt: true,
      reminderWindowClosed: true
    }
  }).catch(() => null);
}

async function handleAppointmentIntentDirectly({ prisma, candidate, vacancy, inboundText, booking, intent, classification, currentStep, now = new Date(), nextSlot = null }) {
  if (!booking?.id || !APPOINTMENT_ACTION_INTENTS.has(intent)) return null;

  const transition = await applyInterviewReminderResponse(prisma, {
    bookingId: booking.id,
    currentStatus: booking.status,
    responseText: inboundText,
    intent
  });
  if (transition.count !== 1) return null;

  if (intent === 'confirm_attendance') {
    return buildEngineHandledResult({
      currentStep,
      intent,
      classification,
      reply: `Perfecto, gracias por confirmar asistencia. Te esperamos ${formatInterviewDate(new Date(booking.scheduledAt))}.`
    });
  }

  if (intent === 'cancel_interview') {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });
    return buildEngineHandledResult({
      currentStep,
      intent,
      classification,
      reply: 'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.'
    });
  }

  if (intent === 'reschedule_interview') {
    const lastInboundAt = candidate.lastInboundAt ? new Date(candidate.lastInboundAt) : null;
    const alternative = nextSlot?.slot && !nextSlot?.isConfirmedBooking
      ? nextSlot
      : (vacancy?.id
        ? await getNextAvailableSlotAfter(prisma, vacancy.id, lastInboundAt, booking, now).catch(() => null)
        : null);

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.SCHEDULING,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });

    const reply = alternative?.slot
      ? `Listo, dejé marcada la solicitud de reprogramación. Te puedo ofrecer ${alternative.formattedDate}; si te sirve, respóndeme confirmando ese horario.`
      : 'Listo, dejé marcada la solicitud de reprogramación. En este momento no tengo otro horario válido para ofrecerte, así que el equipo te contactará para ayudarte con la reprogramación.';

    return buildEngineHandledResult({ currentStep: ConversationStep.SCHEDULING, intent, classification, reply });
  }

  return null;
}

async function analyzePausedVacancyConsent({ candidate, vacancy, inboundText, currentStep, recentMessages }) {
  if (!process.env.OPENAI_API_KEY) {
    return { decision: 'ambiguous', confidence: 0, evidence: '', reason: 'openai_disabled' };
  }

  const context = {
    candidateMessage: String(inboundText || '').slice(0, 2000),
    currentStep,
    candidate: {
      id: candidate?.id || null,
      botResumeMode: candidate?.botResumeMode || null,
      currentStep: candidate?.currentStep || null,
      knownName: candidate?.fullName || null,
      hasCv: Boolean(candidate?.cvStorageKey || candidate?.cvData)
    },
    vacancy: {
      title: vacancy?.title || null,
      role: vacancy?.role || null,
      city: vacancy?.operation?.city?.name || vacancy?.city || null,
      isActive: Boolean(vacancy?.isActive),
      acceptingApplications: Boolean(vacancy?.acceptingApplications)
    },
    recentConversation: (recentMessages || []).slice(-8).map((message) => ({
      direction: message?.direction || null,
      body: String(message?.body || '').slice(0, 600)
    }))
  };

  const payload = {
    model: CONSENT_MODEL,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `Eres un clasificador de consentimiento para un flujo de reclutamiento por WhatsApp.
No respondas al candidato. Solo clasifica el último mensaje con el contexto completo.

Contexto de negocio:
- La vacante ya fue identificada, pero está pausada o no recibe postulaciones activas.
- El bot ofreció opcionalmente dejar el perfil del candidato registrado para futuras aperturas.
- Tu tarea es decidir si el último mensaje acepta ese registro, lo rechaza, o no es suficiente.

Criterios:
- Usa el estado y la conversación reciente; no clasifiques por una palabra aislada.
- Aceptar significa que el candidato quiere dejar su perfil, datos u hoja de vida para futuras aperturas, sabiendo que no hay entrevista activa.
- Rechazar significa que no quiere continuar, prefiere no dejar datos, o se despide.
- Ambiguo significa que solo aclara ciudad/cargo, hace una pregunta, envía información distinta, saluda, o la intención no es clara.
- Si no hay evidencia suficiente en el último mensaje, usa ambiguous.
- Devuelve evidence como fragmento breve del mensaje que sostiene la decisión.`
          }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify(context) }]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'paused_vacancy_consent',
        strict: true,
        schema: PAUSED_CONSENT_SCHEMA
      }
    }
  };

  try {
    const response = await axios.post(RESPONSES_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 12000
    });
    const parsed = parseStructuredOutput(response.data);
    if (!parsed || typeof parsed !== 'object') {
      return { decision: 'ambiguous', confidence: 0, evidence: '', reason: 'invalid_structured_output' };
    }
    return {
      decision: ['accept', 'decline', 'ambiguous'].includes(parsed.decision) ? parsed.decision : 'ambiguous',
      confidence: Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      evidence: String(parsed.evidence || '').slice(0, 220),
      reason: String(parsed.reason || '').slice(0, 280)
    };
  } catch (error) {
    return { decision: 'ambiguous', confidence: 0, evidence: '', reason: 'structured_consent_error' };
  }
}

async function guardPausedVacancy({ prisma, candidate, vacancy, inboundText, recentMessages, currentStep }) {
  if (!vacancy || isOpenVacancy(vacancy)) return null;
  if (candidate?.botResumeMode === PAUSED_VACANCY_CAPTURE) return null;

  const waiting = candidate?.botResumeMode === PAUSED_VACANCY_FLAG;

  if (waiting) {
    const consent = await analyzePausedVacancyConsent({ candidate, vacancy, inboundText, currentStep, recentMessages });
    const highConfidence = consent.confidence >= 0.68;

    if (highConfidence && consent.decision === 'accept') {
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
        reason: 'accepted',
        consent
      });
    }

    if (highConfidence && consent.decision === 'decline') {
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
        reason: 'declined',
        consent
      });
    }

    return buildBypassResult({
      reply: pausedVacancyMessage(vacancy),
      nextStep: currentStep,
      reason: 'ambiguous',
      consent
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
    reason: 'requested'
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
  const storedActiveInterviewBooking = await loadActiveInterviewBooking(prisma, candidate.id);
  const activeInterviewBooking = storedActiveInterviewBooking || (nextSlot?.isConfirmedBooking
    ? { status: 'SCHEDULED', scheduledAt: nextSlot.date }
    : null);
  const interviewIntentClassification = await classifyInterviewIntent({
    text: inboundText,
    booking: activeInterviewBooking,
    now: new Date()
  });
  const interviewIntent = interviewIntentClassification.intent;

  if (
    activeInterviewBooking
    && [ConversationStep.SCHEDULING, ConversationStep.SCHEDULED].includes(currentStep)
    && APPOINTMENT_ACTION_INTENTS.has(interviewIntent)
  ) {
    const directResult = await handleAppointmentIntentDirectly({
      prisma,
      candidate,
      vacancy,
      inboundText,
      booking: activeInterviewBooking,
      intent: interviewIntent,
      classification: interviewIntentClassification,
      currentStep,
      now: new Date(),
      nextSlot
    });
    if (directResult) return directResult;
  }

  const pausedGuard = await guardPausedVacancy({ prisma, candidate, vacancy, inboundText, recentMessages, currentStep });
  if (pausedGuard) return pausedGuard;

  const readiness = getCandidateReadiness(candidate, vacancy);
  const shouldEvaluateGate = Boolean(
    currentStep === ConversationStep.SCHEDULED
    || currentStep === ConversationStep.DONE
    || readiness.readyForDone
    || Boolean(activeInterviewBooking)
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
      interviewIntent,
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

  const progressReply = buildDeterministicProgressReply(actResult);
  const guardedReply = actResult?.blockedActions?.length
    ? buildMissingFieldReply(actResult.readiness)
    : (progressReply || result.reply);
  const profileScopeGuard = guardReplyAgainstReadinessDrift(
    guardedReply,
    actResult?.readiness || readiness
  );

  const safeReply = sanitizeOutboundReply({
    reply: profileScopeGuard.reply,
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
    blockedActions: [
      ...(actResult?.blockedActions || []),
      ...(profileScopeGuard.blocked ? [{
        action: 'reply_scope_guard',
        reason: profileScopeGuard.reason,
        requestedFieldsOutsideReadiness: profileScopeGuard.requestedFieldsOutsideReadiness
      }] : [])
    ],
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
