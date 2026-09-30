import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { enqueueInboundMessage } from '../services/jobQueue.js';
import { deriveCandidatePendingFields } from '../core/middlewares/buildConversationTurnInput.js';

export const REMINDER_POLL_MS = 5 * 60 * 1000;
const INACTIVITY_MS = 2 * 60 * 60 * 1000;
const INTERVIEW_LEAD_MS = 60 * 60 * 1000;
const INTERVIEW_HALF_WINDOW_MS = REMINDER_POLL_MS / 2;

const prisma = new PrismaClient();

function systemPayload({ messageId, phone, intent, now }) {
  return {
    messageId,
    from: phone,
    timestamp: now.toISOString(),
    type: 'system',
    isSystemAction: true,
    intent
  };
}

async function enqueueInactivityReminder(candidate, dependencies, now) {
  const activePrisma = dependencies.prisma;
  const enqueue = dependencies.enqueueInboundMessage ?? enqueueInboundMessage;
  const cycle = new Date(candidate.updatedAt).toISOString();

  return activePrisma.$transaction(async (tx) => {
    const claimed = await tx.candidate.updateMany({
      where: {
        id: candidate.id,
        botPaused: false,
        inactivityReminderSent: false,
        updatedAt: candidate.updatedAt
      },
      data: { inactivityReminderSent: true }
    });
    if (claimed.count !== 1) return false;

    await enqueue(systemPayload({
      messageId: `system:inactivity:${candidate.id}:${cycle}`,
      phone: candidate.phone,
      intent: 'INACTIVITY_REMINDER',
      now
    }), { prisma: tx });
    return true;
  });
}

async function enqueueInterviewReminder(booking, dependencies, now) {
  const activePrisma = dependencies.prisma;
  const enqueue = dependencies.enqueueInboundMessage ?? enqueueInboundMessage;

  return activePrisma.$transaction(async (tx) => {
    const claimed = await tx.interviewBooking.updateMany({
      where: {
        id: booking.id,
        status: 'SCHEDULED',
        interviewReminderSent: false,
        scheduledAt: booking.scheduledAt
      },
      data: { interviewReminderSent: true }
    });
    if (claimed.count !== 1) return false;

    await enqueue(systemPayload({
      messageId: `system:interview:${booking.id}`,
      phone: booking.candidate.phone,
      intent: 'INTERVIEW_REMINDER',
      now
    }), { prisma: tx });
    return true;
  });
}

export async function runReminderSweep(dependencies = {}, options = {}) {
  const activePrisma = dependencies.prisma ?? prisma;
  const now = options.now instanceof Date ? options.now : new Date();
  const staleBefore = new Date(now.getTime() - INACTIVITY_MS);
  const interviewFrom = new Date(now.getTime() + INTERVIEW_LEAD_MS - INTERVIEW_HALF_WINDOW_MS);
  const interviewTo = new Date(now.getTime() + INTERVIEW_LEAD_MS + INTERVIEW_HALF_WINDOW_MS);

  const candidates = await activePrisma.candidate.findMany({
    where: {
      botPaused: false,
      inactivityReminderSent: false,
      updatedAt: { lt: staleBefore }
    },
    include: { vacancy: true }
  });
  const inactiveCandidates = candidates.filter((candidate) => (
    deriveCandidatePendingFields(candidate).length > 0
  ));

  const bookings = await activePrisma.interviewBooking.findMany({
    where: {
      status: 'SCHEDULED',
      interviewReminderSent: false,
      scheduledAt: { gte: interviewFrom, lt: interviewTo }
    },
    include: { candidate: true }
  });

  let inactivityEnqueued = 0;
  for (const candidate of inactiveCandidates) {
    if (await enqueueInactivityReminder(candidate, {
      ...dependencies,
      prisma: activePrisma
    }, now)) inactivityEnqueued += 1;
  }

  let interviewEnqueued = 0;
  for (const booking of bookings) {
    if (await enqueueInterviewReminder(booking, {
      ...dependencies,
      prisma: activePrisma
    }, now)) interviewEnqueued += 1;
  }

  return { inactivityEnqueued, interviewEnqueued };
}

export function startCronReminders(dependencies = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runReminderSweep(dependencies);
    } catch (error) {
      console.error('[CRON_REMINDERS_ERROR]', error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(run, REMINDER_POLL_MS);
  console.log('[CRON_REMINDERS_STARTED]', { pollMs: REMINDER_POLL_MS });
  return timer;
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) startCronReminders();
