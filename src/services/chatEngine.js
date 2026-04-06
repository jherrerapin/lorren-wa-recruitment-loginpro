import { ConversationStep } from '@prisma/client';
import { think, act, extractEngineCandidateFields } from './conversationEngine.js';

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
  };
}
