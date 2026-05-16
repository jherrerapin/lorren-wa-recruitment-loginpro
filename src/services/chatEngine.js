import { ConversationStep } from '@prisma/client';
import { think, act, extractEngineCandidateFields, hasRecentHumanIntervention } from './conversationEngine.js';
import { sanitizeCandidateFieldsForConversation } from './fieldSanitizer.js';
import { sanitizeOutboundReply } from './replySafety.js';
import { buildMissingFieldReply } from './readinessGuard.js';

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
