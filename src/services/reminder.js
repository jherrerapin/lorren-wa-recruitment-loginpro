import { sendTextMessage } from './whatsapp.js';
import { canScheduleReminderPolicy, isWithinWhatsappWindow } from './reminderPolicy.js';
import { getCandidateResidenceValue, getResidenceFieldConfig } from './candidateData.js';

const REMINDER_DELAY_MS = 25 * 60 * 1000;

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

  const missingHv = !hasValue(candidate?.cvData);
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

export async function runReminderDispatcher(prisma, { now = new Date() } = {}) {
  const dueCandidates = await prisma.candidate.findMany({
    where: {
      reminderState: 'SCHEDULED',
      reminderScheduledFor: { lte: now }
    },
    take: 100
  });

  for (const candidate of dueCandidates) {
    const shouldSkip = !canScheduleReminder(candidate) || !isWithinWhatsappWindow(candidate.lastInboundAt);
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
}
