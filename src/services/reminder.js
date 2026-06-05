import { sendTextMessage } from './whatsapp.js';
import {
  canScheduleReminderPolicy,
  canSendInterviewKeepalivePolicy,
  getWhatsappWindowState,
} from './reminderPolicy.js';
import { getCandidateResidenceValue, getResidenceFieldConfig } from './candidateData.js';
import { formatInterviewDate } from './interviewScheduler.js';
import {
  detectInterviewIntent,
  hasActiveInterviewBooking,
  shouldMarkNoResponse,
  shouldStopInterviewAutomation,
} from './interviewLifecycle.js';
import { isFeatureEnabled } from './featureFlags.js';
import { enqueueJob, JOB_TYPES } from './jobQueue.js';

export const CANDIDATE_PROCESS_REMINDER_DELAY_MS = Number.parseInt(
  process.env.CANDIDATE_PROCESS_REMINDER_DELAY_MS || String(2 * 60 * 60 * 1000),
  10
) || (2 * 60 * 60 * 1000);
const INTERVIEW_REMINDER_LEAD_MS = Number.parseInt(
  process.env.INTERVIEW_REMINDER_LEAD_MS || String(40 * 60 * 1000), 10
) || (40 * 60 * 1000);
const INTERVIEW_REMINDER_EARLY_TOLERANCE_MS = 5 * 60 * 1000;
const INTERVIEW_REMINDER_LATE_TOLERANCE_MS = 10 * 60 * 1000;
const ACTIVE_INTERVIEW_STATUSES = ['SCHEDULED', 'CONFIRMED'];
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
    missingParts.push('tu hoja de vida (HV) en PDF o Word/DOCX');
  }

  if (!missingParts.length) {
    return 'Hola, te escribo para recordarte que tu proceso sigue abierto. Si necesitas apoyo para continuar, aquí quedo atento.';
  }

  return `Hola, te escribo para recordarte que tu proceso sigue abierto. Para completar tu postulación aún me falta ${formatList(missingParts)}.`;
}

function getCandidateFirstName(candidate = {}) {
  return String(candidate?.fullName || '').trim().split(/\s+/)[0] || 'candidato/a';
}

function getVacancyTitle(candidate = {}, vacancy = {}) {
  return vacancy?.title || vacancy?.role || candidate?.vacancy?.title || candidate?.vacancy?.role || candidate?.vacancyTitle || 'la vacante';
}

function getVacancyRole(candidate = {}, vacancy = {}) {
  return vacancy?.role || candidate?.vacancy?.role || getVacancyTitle(candidate, vacancy);
}

function getInterviewPlace(vacancy = {}) {
  return vacancy?.interviewAddress || vacancy?.operationAddress || vacancy?.address || 'la modalidad o lugar acordado';
}

function buildInterviewReminderText(candidate = {}, booking = {}, vacancy = {}) {
  const scheduledDate = booking?.scheduledAt ? formatInterviewDate(new Date(booking.scheduledAt)) : 'el horario acordado';
  const candidateName = getCandidateFirstName(candidate);
  const vacancyTitle = getVacancyTitle(candidate, vacancy);
  const role = getVacancyRole(candidate, vacancy);
  const place = getInterviewPlace(vacancy);
  return `Hola ${candidateName}, te recuerdo que tienes entrevista para ${role} (${vacancyTitle}) ${scheduledDate} en ${place}. ¿Confirmas tu asistencia?`;
}

function buildInterviewFiveMinuteText(candidate = {}) {
  const candidateName = getCandidateFirstName(candidate);
  return `Hola ${candidateName}, tu entrevista es en 5 minutos, ¿ya estás en camino?`;
}

export function canScheduleReminder(candidate) {
  return canScheduleReminderPolicy(candidate);
}

async function claimCandidateProcessReminder(prisma, candidateId, now) {
  if (typeof prisma?.candidate?.updateMany !== 'function') return false;
  const result = await prisma.candidate.updateMany({
    where: {
      id: candidateId,
      reminderState: 'SCHEDULED',
      reminderScheduledFor: { lte: now }
    },
    data: {
      reminderState: 'SENT',
      reminderScheduledFor: null,
      lastReminderAt: now,
      lastOutboundAt: now
    }
  });
  return result.count === 1;
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

  const reminderAt = new Date(now.getTime() + CANDIDATE_PROCESS_REMINDER_DELAY_MS);
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      reminderState: 'SCHEDULED',
      reminderScheduledFor: reminderAt
    }
  });

  if (prisma?.jobQueue?.create && isFeatureEnabled('FF_POSTGRES_JOB_QUEUE', false)) {
    await enqueueJob(prisma, {
      type: JOB_TYPES.CANDIDATE_PROCESS_REMINDER,
      payload: { candidateId },
      runAt: reminderAt,
      dedupeKey: `candidate:${candidateId}:process-reminder:${reminderAt.toISOString()}`,
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

async function findBookingVacancy(prisma, booking = {}, candidate = {}) {
  const vacancyId = booking?.vacancyId || candidate?.vacancyId || candidate?.vacancy?.id;
  if (!vacancyId || typeof prisma?.vacancy?.findUnique !== 'function') return candidate?.vacancy || {};
  return prisma.vacancy.findUnique({ where: { id: vacancyId } }).catch(() => candidate?.vacancy || {});
}

async function findActiveInterviewBooking(prisma, candidateId) {
  if (typeof prisma?.interviewBooking?.findFirst !== 'function') return null;
  return prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      status: { in: ACTIVE_INTERVIEW_STATUSES }
    },
    orderBy: { scheduledAt: 'asc' }
  });
}

async function claimInterviewReminder(prisma, bookingId, statusField, now) {
  if (typeof prisma?.interviewBooking?.updateMany !== 'function') return false;
  const fieldMap = {
    reminder1hSentAt: { reminder1hSentAt: null },
    reminder5mSentAt: { reminder5mSentAt: null }
  };
  const result = await prisma.interviewBooking.updateMany({
    where: { id: bookingId, ...fieldMap[statusField] },
    data: { [statusField]: now }
  });
  return result.count === 1;
}

export async function processScheduledReminders(prisma, now = new Date()) {
  const due = await prisma.candidate.findMany({
    where: {
      reminderState: 'SCHEDULED',
      reminderScheduledFor: { lte: now }
    },
    include: { vacancy: true }
  });

  for (const candidate of due) {
    if (!canScheduleReminder(candidate)) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { reminderState: 'SKIPPED', reminderScheduledFor: null }
      });
      console.log('[REMINDER_TRACE]', JSON.stringify({ candidateId: candidate.id, event: 'reminder_skipped_due_policy' }));
      continue;
    }
    const claimed = await claimCandidateProcessReminder(prisma, candidate.id, now);
    if (!claimed) continue;
    const body = buildReminderText(candidate);
    await sendTextMessage(candidate.phone, body);
    await storeOutbound(prisma, candidate.id, body, { source: 'candidate_process_reminder' });
  }
}

export async function sendInterviewWindowKeepalive(prisma, candidateId, now = new Date()) {
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!canSendInterviewKeepalivePolicy(candidate, now)) return false;

  const body = 'Hola, seguimos pendientes de tu proceso. Si necesitas confirmar o cambiar algo de tu entrevista, escríbeme por aquí.';
  await sendTextMessage(candidate.phone, body);
  await storeOutbound(prisma, candidate.id, body, { source: INTERVIEW_KEEPALIVE_SOURCE });
  await prisma.candidate.update({
    where: { id: candidateId },
    data: { lastOutboundAt: now }
  });
  return true;
}

export async function sendInterviewBookingReminder(prisma, bookingId, now = new Date()) {
  const booking = await prisma.interviewBooking.findUnique({
    where: { id: bookingId },
    include: { candidate: true }
  });
  if (!booking || !ACTIVE_INTERVIEW_STATUSES.includes(booking.status)) return false;

  const vacancy = await findBookingVacancy(prisma, booking, booking.candidate);
  const msUntilInterview = new Date(booking.scheduledAt).getTime() - now.getTime();
  const reminderField = msUntilInterview <= (5 * 60 * 1000 + INTERVIEW_REMINDER_EARLY_TOLERANCE_MS)
    ? 'reminder5mSentAt'
    : 'reminder1hSentAt';

  const targetLead = reminderField === 'reminder5mSentAt' ? 5 * 60 * 1000 : INTERVIEW_REMINDER_LEAD_MS;
  if (msUntilInterview < targetLead - INTERVIEW_REMINDER_LATE_TOLERANCE_MS) return false;
  if (msUntilInterview > targetLead + INTERVIEW_REMINDER_EARLY_TOLERANCE_MS) return false;

  const claimed = await claimInterviewReminder(prisma, booking.id, reminderField, now);
  if (!claimed) return false;

  const body = reminderField === 'reminder5mSentAt'
    ? buildInterviewFiveMinuteText(booking.candidate)
    : buildInterviewReminderText(booking.candidate, booking, vacancy);
  await sendTextMessage(booking.candidate.phone, body);
  await storeOutbound(prisma, booking.candidate.id, body, { source: INTERVIEW_BOOKING_REMINDER_SOURCE, bookingId: booking.id, reminderField });
  await prisma.candidate.update({
    where: { id: booking.candidate.id },
    data: { lastOutboundAt: now }
  });
  return true;
}
