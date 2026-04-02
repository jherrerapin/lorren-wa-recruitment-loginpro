import { CandidateStatus, ConversationStep, MessageDirection, MessageType, ReminderState } from '@prisma/client';
import { sendTextMessage } from './whatsapp.js';

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
const REMINDER_DELAY_MS = 25 * 60 * 1000;

const REMINDER_ELIGIBLE_STEPS = new Set([
  ConversationStep.GREETING_SENT,
  ConversationStep.COLLECTING_DATA,
  ConversationStep.CONFIRMING_DATA,
  ConversationStep.ASK_CV
]);

export const REMINDER_TEXT = 'Hola 👋 Te escribo para recordar que tu proceso sigue abierto. Si deseas continuar, envíame los datos faltantes o tu Hoja de vida (HV).';

export function isWithinWhatsappWindow(lastInboundAt) {
  if (!lastInboundAt) return false;
  return (Date.now() - new Date(lastInboundAt).getTime()) <= WHATSAPP_WINDOW_MS;
}

export function canScheduleReminder(candidate) {
  if (!candidate) return false;
  if (candidate.status === CandidateStatus.RECHAZADO) return false;
  if (candidate.currentStep === ConversationStep.DONE) return false;
  if (!REMINDER_ELIGIBLE_STEPS.has(candidate.currentStep)) return false;
  if (candidate.reminderState === ReminderState.SENT || candidate.lastReminderAt) return false;
  if (!candidate.lastInboundAt) return false;
  return true;
}

export async function scheduleReminderForCandidate(prisma, candidateId, now = new Date()) {
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!canScheduleReminder(candidate)) {
    if (candidate && candidate.reminderState === ReminderState.SCHEDULED) {
      await prisma.candidate.update({
        where: { id: candidateId },
        data: { reminderState: ReminderState.SKIPPED, reminderScheduledFor: null }
      });
      console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId, event: 'reminder_skipped' }));
    }
    return;
  }

  const alreadyScheduled = candidate.reminderState === ReminderState.SCHEDULED && candidate.reminderScheduledFor;
  if (alreadyScheduled) return;

  const reminderAt = new Date(now.getTime() + REMINDER_DELAY_MS);
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      reminderState: ReminderState.SCHEDULED,
      reminderScheduledFor: reminderAt
    }
  });

  console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId, event: 'reminder_scheduled', reminderAt: reminderAt.toISOString() }));
}

export async function cancelReminderOnInbound(prisma, candidateId) {
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate) return;
  if (candidate.reminderState !== ReminderState.SCHEDULED) return;

  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      reminderState: ReminderState.CANCELLED,
      reminderScheduledFor: null
    }
  });

  console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId, event: 'reminder_cancelled' }));
}

async function storeOutbound(prisma, candidateId, body, metadata = {}) {
  await prisma.message.create({
    data: {
      candidateId,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      body,
      rawPayload: metadata
    }
  });
}

export async function runReminderDispatcher(prisma, { now = new Date() } = {}) {
  const dueCandidates = await prisma.candidate.findMany({
    where: {
      reminderState: ReminderState.SCHEDULED,
      reminderScheduledFor: { lte: now }
    },
    take: 100
  });

  for (const candidate of dueCandidates) {
    const shouldSkip = !canScheduleReminder(candidate) || !isWithinWhatsappWindow(candidate.lastInboundAt);
    if (shouldSkip) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { reminderState: ReminderState.SKIPPED, reminderScheduledFor: null }
      });
      console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId: candidate.id, event: 'reminder_skipped' }));
      continue;
    }

    await sendTextMessage(candidate.phone, REMINDER_TEXT);
    await storeOutbound(prisma, candidate.id, REMINDER_TEXT, { source: 'auto_reminder' });
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        reminderState: ReminderState.SENT,
        reminderScheduledFor: null,
        lastReminderAt: now,
        lastOutboundAt: now
      }
    });
    console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId: candidate.id, event: 'reminder_sent' }));
  }
}
