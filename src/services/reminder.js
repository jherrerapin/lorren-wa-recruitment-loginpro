import { sendTextMessage } from './whatsapp.js';
import {
  canScheduleReminderPolicy,
  canSendInterviewKeepalivePolicy,
  getWhatsappWindowState,
} from './reminderPolicy.js';
import { getCandidateResidenceValue, getResidenceFieldConfig } from './candidateData.js';
import { formatInterviewDate } from './interviewScheduler.js';
import { isFeatureEnabled } from './featureFlags.js';
import { enqueueJob, JOB_TYPES } from './jobQueue.js';

const REMINDER_DELAY_MS = 60 * 60 * 1000;
const INTERVIEW_KEEPALIVE_SOURCE = 'interview_window_keepalive';

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function buildRequiredFields(candidate = {}) {
  const residenceConfig = getResidenceFieldConfig(candidate?.vacancy);
  return [
    ['fullName', 'nombre completo'],
    ['documentType', 'tipo de documento'],
    ['documentNumber', 'número de documento'],
    ['age', 'edad'],
    [residenceConfig.field, residenceConfig.label],
    ['medicalRestrictions', 'restricciones médicas'],
    ['transportMode', 'medio de transporte']
  ];
}

function formatList(items = []) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} y ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

export function getReminderMissingItems(candidate = {}) {
  const residenceConfig = getResidenceFieldConfig(candidate?.vacancy);
  const missingFields = buildRequiredFields(candidate)
    .filter(([field]) => (
      field === residenceConfig.field
        ? !hasValue(getCandidateResidenceValue(candidate, candidate?.vacancy))
        : !hasValue(candidate?.[field])
    ))
    .map(([, label]) => label);

  const missingHv = !hasValue(candidate?.cvStorageKey) && !hasValue(candidate?.cvData);
  return { missingFields, missingHv };
}

export function buildReminderText(candidate = {}) {
  const { missingFields, missingHv } = getReminderMissingItems(candidate);
  const missingParts = [];

  if (missingFields.length) {
    missingParts.push(`estos datos: ${formatList(missingFields)}`);
  }
  if (missingHv) {
    missingParts.push('tu hoja de vida (HV) en PDF o Word (.doc/.docx)');
  }

  if (!missingParts.length) {
    return 'Hola, te escribo para recordarte que tu proceso sigue abierto. Si necesitas apoyo para continuar, aquí quedo atento.';
  }

  return `Hola, te escribo para recordarte que tu proceso sigue abierto. Para completar tu postulación aún me falta ${formatList(missingParts)}.`;
}

export function canScheduleReminder(candidate) {
  return canScheduleReminderPolicy(candidate);
}

export async function scheduleReminderForCandidate(prisma, candidateId, now = new Date()) {
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!canScheduleReminder(candidate)) {
    if (candidate && candidate.reminderState === 'SCHEDULED') {
      await prisma.candidate.update({
        where: { id: candidateId },
        data: { reminderState: 'SKIPPED', reminderScheduledFor: null }
      });
      console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId, event: 'reminder_skipped' }));
    }
    return;
  }

  const alreadyScheduled = candidate.reminderState === 'SCHEDULED' && candidate.reminderScheduledFor;
  if (alreadyScheduled) return;

  const reminderAt = new Date(now.getTime() + REMINDER_DELAY_MS);
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      reminderState: 'SCHEDULED',
      reminderScheduledFor: reminderAt
    }
  });

  if (prisma?.jobQueue?.create && isFeatureEnabled('FF_POSTGRES_JOB_QUEUE', false)) {
    await enqueueJob(prisma, {
      type: JOB_TYPES.INTERVIEW_REMINDER,
      payload: { candidateId },
      runAt: reminderAt,
      dedupeKey: `candidate:${candidateId}:reminder:${reminderAt.toISOString()}`,
      maxAttempts: 5
    }).catch((error) => {
      console.warn('[REMINDER_QUEUE_ENQUEUE_FAILED]', { candidateId, error: error?.message || error });
    });
  }

  console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId, event: 'reminder_scheduled', reminderAt: reminderAt.toISOString() }));
}

export async function cancelReminderOnInbound(prisma, candidateId) {
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!candidate) return;
  if (candidate.reminderState !== 'SCHEDULED') return;

  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      reminderState: 'CANCELLED',
      reminderScheduledFor: null
    }
  });

  console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId, event: 'reminder_cancelled' }));
}

async function storeOutbound(prisma, candidateId, body, metadata = {}) {
  await prisma.message.create({
    data: {
      candidateId,
      direction: 'OUTBOUND',
      messageType: 'TEXT',
      body,
      rawPayload: metadata
    }
  });
}

async function findActiveInterviewBooking(prisma, candidateId) {
  if (typeof prisma?.interviewBooking?.findFirst !== 'function') return null;
  return prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      status: { in: ['SCHEDULED', 'CONFIRMED'] }
    },
    orderBy: { scheduledAt: 'asc' },
    select: {
      scheduledAt: true,
      status: true,
      reminderSentAt: true,
      reminderWindowClosed: true
    }
  });
}

function buildInterviewKeepaliveText(candidate = {}, booking = null) {
  if (candidate.currentStep === 'SCHEDULED') {
    const scheduledDate = booking?.scheduledAt ? formatInterviewDate(new Date(booking.scheduledAt)) : null;
    if (scheduledDate) {
      return `Tu entrevista sigue programada para ${scheduledDate}. Si necesitas ajustar algo o confirmar que sigues disponible, respóndeme por aquí para mantener este chat activo.`;
    }
    return 'Tu proceso de entrevista sigue activo. Si necesitas ajustar algo o confirmarme que sigues disponible, respóndeme por aquí para mantener este chat abierto.';
  }

  return 'Sigo pendiente de tu confirmación para la entrevista. Si sigues interesado, respóndeme por aquí con un sí o dime si necesitas otro horario para mantener tu proceso activo.';
}

async function hasInterviewKeepaliveSinceLastInbound(prisma, candidateId, lastInboundAt) {
  if (!lastInboundAt || typeof prisma?.message?.findMany !== 'function') return false;
  const recentOutbounds = await prisma.message.findMany({
    where: {
      candidateId,
      direction: 'OUTBOUND',
      createdAt: { gte: lastInboundAt }
    },
    orderBy: { createdAt: 'desc' },
    take: 20
  });

  return recentOutbounds.some((message) => message?.rawPayload?.source === INTERVIEW_KEEPALIVE_SOURCE);
}

async function runInterviewKeepaliveDispatcher(prisma, now = new Date()) {
  if (typeof prisma?.candidate?.findMany !== 'function') return;

  const candidates = await prisma.candidate.findMany({
    where: {
      currentStep: { in: ['SCHEDULING', 'SCHEDULED'] },
      botPaused: false
    },
    take: 200
  });

  for (const candidate of candidates) {
    if (!canSendInterviewKeepalivePolicy(candidate, now)) continue;
    if (await hasInterviewKeepaliveSinceLastInbound(prisma, candidate.id, candidate.lastInboundAt)) continue;

    const booking = candidate.currentStep === 'SCHEDULED'
      ? await findActiveInterviewBooking(prisma, candidate.id)
      : null;

    if (isFeatureEnabled('FF_STOP_KEEPALIVE_AFTER_INTERVIEW', false) && booking?.scheduledAt) {
      const scheduledAt = new Date(booking.scheduledAt);
      const closedStatuses = new Set(['CANCELLED', 'RESCHEDULED', 'NO_SHOW', 'ATTENDED']);
      if (scheduledAt <= now || booking.reminderSentAt || booking.reminderWindowClosed || closedStatuses.has(booking.status)) {
        continue;
      }
    }

    const body = buildInterviewKeepaliveText(candidate, booking);
    const windowState = getWhatsappWindowState(candidate.lastInboundAt, now);

    await sendTextMessage(candidate.phone, body);
    await storeOutbound(prisma, candidate.id, body, {
      source: INTERVIEW_KEEPALIVE_SOURCE,
      windowExpiresAt: windowState.expiresAt?.toISOString?.() || null
    });
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        lastOutboundAt: now
      }
    });
    console.log('[REMINDER_TRACE]', JSON.stringify({
      candidateId: candidate.id,
      event: 'interview_window_keepalive_sent',
      currentStep: candidate.currentStep
    }));
  }
}

export async function runReminderDispatcher(prisma, { now = new Date() } = {}) {
  const dueCandidates = await prisma.candidate.findMany({
    where: {
      reminderState: 'SCHEDULED',
      reminderScheduledFor: { lte: now }
    },
    take: 100
  });

  for (const candidate of dueCandidates) {
    const shouldSkip = !canScheduleReminder(candidate) || !getWhatsappWindowState(candidate.lastInboundAt, now).isOpen;
    if (shouldSkip) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { reminderState: 'SKIPPED', reminderScheduledFor: null }
      });
      console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId: candidate.id, event: 'reminder_skipped' }));
      continue;
    }

    const reminderText = buildReminderText(candidate);
    await sendTextMessage(candidate.phone, reminderText);
    await storeOutbound(prisma, candidate.id, reminderText, { source: 'auto_reminder' });
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        reminderState: 'SENT',
        reminderScheduledFor: null,
        lastReminderAt: now,
        lastOutboundAt: now
      }
    });
    console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId: candidate.id, event: 'reminder_sent' }));
  }

  await runInterviewKeepaliveDispatcher(prisma, now);
}
