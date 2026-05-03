import { ConversationStep } from '@prisma/client';
import { think, act, extractEngineCandidateFields, hasRecentHumanIntervention } from './conversationEngine.js';

function latestOutboundWasManualHuman(recentMessages = []) {
  const lastOutbound = [...(recentMessages || [])]
    .reverse()
    .find((message) => message?.direction === 'OUTBOUND');

  if (!lastOutbound) return false;
  return hasRecentHumanIntervention([lastOutbound]);
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

  if (!candidate.botPaused && latestOutboundWasManualHuman(recentMessages)) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        botPaused: true,
        botPausedAt: new Date(),
        botPauseReason: 'Intervencion humana detectada en el chat',
        reminderScheduledFor: null,
        reminderState: 'CANCELLED'
      }
    });

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

  await act({
    actions,
    candidate,
    extractedFields,
    candidateFields,
    nextStep: result.nextStep,
    nextSlot,
    prisma,
  });

  return {
    reply: result.reply,
    actions,
    nextStep: result.nextStep,
    extractedFields,
    candidateFields,
    fallback: result.fallback,
    fallbackReason: result.fallbackReason || null,
    loopGuardApplied: Boolean(result.loopGuardApplied),
    usage: result.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    suppressed: false,
    suppressedReason: null,
  };
}
