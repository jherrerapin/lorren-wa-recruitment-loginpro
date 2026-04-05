import { ConversationStep } from '@prisma/client';
import { think, act } from './conversationEngine.js';

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

  await act({
    actions: result.actions,
    candidate,
    extractedFields: result.extractedFields,
    nextStep: result.nextStep,
    nextSlot,
    prisma,
  });

  return {
    reply: result.reply,
    actions: result.actions,
    nextStep: result.nextStep,
    extractedFields: result.extractedFields,
    fallback: result.fallback,
  };
}
