import { sendTextMessage } from './whatsapp.js';
import {
  canScheduleReminderPolicy,
  canSendInterviewKeepalivePolicy,
  getWhatsappWindowState,
} from './reminderPolicy.js';
import { getCandidateResidenceValue, getResidenceFieldConfig } from './candidateData.js';
import { formatInterviewDate, getInterviewReminderAt } from './interviewScheduler.js';
import {
  getInterviewNoResponseMinutesBefore,
  hasActiveInterviewBooking,
  shouldMarkNoResponse,
  shouldStopInterviewAutomation,
} from './interviewLifecycle.js';
import { isFeatureEnabled } from './featureFlags.js';
import { enqueueJob, JOB_TYPES } from './jobQueue.js';

const REMINDER_DELAY_MS = 60 * 60 * 1000;
const INTERVIEW_KEEPALIVE_SOURCE = 'interview_window_keepalive';
const INTERVIEW_BOOKING_REMINDER_SOURCE = 'interview_booking_reminder';

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function buildRequiredFields(candidate = {}) {
  const residenceConfig = getResidenceFieldConfig(candidate?.vacancy);
  const fields = [
    ['fullName', 'nombre completo'],
    ['documentType', 'tipo de documento'],
    ['documentNumber', 'número de documento'],
    ['age', 'edad'],
    [residenceConfig.field, residenceConfig.label],
    ['medicalRestrictions', 'restricciones médicas'],
    ['transportMode', 'medio de transporte']
  ];

  if (candidate?.vacancy?.experienceRequired === 'YES') {
    fields.push(['experienceInfo', 'experiencia']);
    const timeLabel = candidate?.vacancy?.experienceTimeText
      ? `tiempo de experiencia (${candidate.vacancy.experienceTimeText})`
      : 'tiempo de experiencia';
    fields.push(['experienceTime', timeLabel]);
  }

  return fields;
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

function buildInterviewReminderText(booking = {}) {
  const scheduledDate = booking?.scheduledAt ? formatInterviewDate(new Date(booking.scheduledAt)) : 'el horario acordado';
  return `Hola, te escribo para recordarte tu entrevista de LoginPro programada para ${scheduledDate}. Si sigues disponible, responde por este medio.`;
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
      id: true,
      scheduledAt: true,
      status: true,
      reminderSentAt: true,
      reminderWindowClosed: true
    }
  });
}

function buildInterviewKeepaliveText(candidate = {}, booking = null) {
  const scheduledDate = booking?.scheduledAt ? formatInterviewDate(new Date(booking.scheduledAt)) : null;
  if (scheduledDate) {
    return `Tu entrevista sigue programada para ${scheduledDate}. Si necesitas ajustar algo, respóndeme por aquí para mantener este chat activo.`;
  }

  if (candidate.currentStep === 'SCHEDULED') {
    return 'Tu proceso de entrevista sigue activo. Si necesitas ajustar algo, respóndeme por aquí para mantener este chat abierto.';
  }

  return 'Sigo pendiente de tu confirmación para la entrevista. Si sigues interesado, respóndeme por aquí para mantener tu proceso activo.';
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

async function hasInterviewReminderReply(prisma, candidateId, reminderSentAt) {
  if (!reminderSentAt || typeof prisma?.message?.findMany !== 'function') return false;
  const inbound = await prisma.message.findMany({
    where: {
      candidateId,
      direction: 'INBOUND',
      createdAt: { gte: reminderSentAt }
    },
    take: 1
  });
  return inbound.length > 0;
}

async function runInterviewBookingReminderDispatcher(prisma, now = new Date(), candidateId = null) {
  if (typeof prisma?.interviewBooking?.findMany !== 'function') return;

  const candidateBookings = await prisma.interviewBooking.findMany({
    where: {
      ...(candidateId ? { candidateId } : {}),
      status: { in: ['SCHEDULED', 'CONFIRMED'] }
    },
    orderBy: { scheduledAt: 'asc' },
    select: {
      id: true,
      candidateId: true,
      scheduledAt: true,
      status: true,
      reminderSentAt: true,
      reminderWindowClosed: true
    }
  });

  for (const booking of candidateBookings) {
    const scheduledAt = new Date(booking.scheduledAt);
    if (scheduledAt <= now) continue;

    const reminderAt = getInterviewReminderAt(scheduledAt);
    if (booking.reminderSentAt || reminderAt > now) continue;

    const candidate = await prisma.candidate.findUnique({ where: { id: booking.candidateId } });
    if (!candidate || candidate.botPaused || !hasActiveInterviewBooking(booking)) continue;

    const reminderText = buildInterviewReminderText(booking);
    await sendTextMessage(candidate.phone, reminderText);
    await storeOutbound(prisma, candidate.id, reminderText, {
      source: INTERVIEW_BOOKING_REMINDER_SOURCE,
      bookingId: booking.id,
      scheduledAt: scheduledAt.toISOString()
    });
    await prisma.interviewBooking.update({
      where: { id: booking.id },
      data: {
        reminderSentAt: now,
        reminderWindowClosed: true
      }
    });
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { lastOutboundAt: now }
    });
  }
}

async function runInterviewNoResponseDispatcher(prisma, now = new Date(), candidateId = null) {
  if (typeof prisma?.interviewBooking?.findMany !== 'function') return;

  const bookings = await prisma.interviewBooking.findMany({
    where: {
      ...(candidateId ? { candidateId } : {}),
      status: { in: ['SCHEDULED', 'CONFIRMED'] },
      reminderSentAt: { not: null }
    },
    select: {
      id: true,
      candidateId: true,
      scheduledAt: true,
      status: true,
      reminderSentAt: true,
      reminderWindowClosed: true
    }
  });

  for (const booking of bookings) {
    const hasReply = await hasInterviewReminderReply(prisma, booking.candidateId, booking.reminderSentAt);
    if (!shouldMarkNoResponse(booking, { now, hasReminderReply: hasReply })) continue;

    await prisma.interviewBooking.update({
      where: { id: booking.id },
      data: {
        status: 'NO_RESPONSE',
        reminderResponse: 'Sin respuesta al recordatorio de entrevista',
        reminderWindowClosed: true
      }
    });
    console.log('[REMINDER_TRACE]', JSON.stringify({
      candidateId: booking.candidateId,
      bookingId: booking.id,
      event: 'interview_no_response_marked',
      thresholdMinutes: getInterviewNoResponseMinutesBefore()
    }));
  }
}

async function runInterviewKeepaliveDispatcher(prisma, now = new Date(), candidateId = null) {
  if (typeof prisma?.candidate?.findMany !== 'function') return;

  const candidates = await prisma.candidate.findMany({
    where: {
      ...(candidateId ? { id: candidateId } : {}),
      currentStep: { in: ['SCHEDULING', 'SCHEDULED'] },
      botPaused: false
    },
    take: 200
  });

  for (const candidate of candidates) {
    if (!canSendInterviewKeepalivePolicy(candidate, now)) continue;

    const booking = await findActiveInterviewBooking(prisma, candidate.id);
    if (!booking || shouldStopInterviewAutomation(booking, now)) continue;
    if (await hasInterviewKeepaliveSinceLastInbound(prisma, candidate.id, candidate.lastInboundAt)) continue;

    const body = buildInterviewKeepaliveText(candidate, booking);
    const windowState = getWhatsappWindowState(candidate.lastInboundAt, now);

    await sendTextMessage(candidate.phone, body);
    await storeOutbound(prisma, candidate.id, body, {
      source: INTERVIEW_KEEPALIVE_SOURCE,
      bookingId: booking.id,
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
      bookingId: booking.id,
      event: 'interview_window_keepalive_sent',
      currentStep: candidate.currentStep
    }));
  }
}

export async function runReminderDispatcher(prisma, { now = new Date(), candidateId = null } = {}) {
  const dueCandidates = await prisma.candidate.findMany({
    where: {
      ...(candidateId ? { id: candidateId } : {}),
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

  await runInterviewBookingReminderDispatcher(prisma, now, candidateId);
  await runInterviewNoResponseDispatcher(prisma, now, candidateId);
  await runInterviewKeepaliveDispatcher(prisma, now, candidateId);
}
