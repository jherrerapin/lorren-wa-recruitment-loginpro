/**
 * interviewFlow.js — Sprint 4
 *
 * Servicio completo del flujo de entrevistas.
 * Responsabilidades:
 *   - bookInterview()       — agenda al candidato en un slot disponible
 *   - confirmInterview()    — marca la entrevista como CONFIRMED
 *   - cancelInterview()     — marca la entrevista como CANCELLED
 *   - rescheduleInterview() — marca como RESCHEDULED y libera el slot
 *   - getAvailableSlots()   — lista slots activos con cupo disponible
 *   - buildSlotLabel()      — formatea el slot en texto natural colombiano
 *   - scheduleInterviewReminder() — registra el recordatorio 1h antes
 *   - processReminderResponse()   — procesa la respuesta del candidato al recordatorio
 *
 * El dispatcher de recordatorios de entrevista corre en reminder.js (polling existente).
 * Este servicio solo persiste y formatea; no hace polling ni timers.
 */

// Prisma con ESM: los enums solo están en el default export del módulo CJS.
import pkg from '@prisma/client';
const { InterviewStatus, ReminderResponse, ConversationStep, CandidateStatus } = pkg;

export { CandidateStatus };

// ---------------------------------------------------------------------------
// Utilidades de formato
// ---------------------------------------------------------------------------

const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * Formatea un slot en texto natural para mensajes de WhatsApp.
 * Ejemplo: "martes 7 de abril a las 10:00 a.m."
 */
export function buildSlotLabel(scheduledAt) {
  const d = new Date(scheduledAt);
  const dia = DIAS_ES[d.getDay()];
  const fecha = d.getDate();
  const mes = MESES_ES[d.getMonth()];
  const hh = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ampm = hh < 12 ? 'a.m.' : 'p.m.';
  const hora12 = hh % 12 || 12;
  return `${dia} ${fecha} de ${mes} a las ${hora12}:${mm} ${ampm}`;
}

/**
 * Construye el listado de slots disponibles para mostrar al candidato.
 * Retorna string multilínea numerado.
 */
export function buildSlotsMenu(slots) {
  if (!slots.length) return null;
  return slots
    .map((s, i) => `${i + 1}. ${s.label || buildSlotLabel(s.scheduledAt)}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

/**
 * Retorna los slots activos con cupo disponible para una vacante.
 * Solo slots futuros, ordenados por fecha ascendente.
 * Máximo 5 para no saturar el prompt.
 */
export async function getAvailableSlots(prisma, vacancyId, limit = 5) {
  if (typeof prisma.interviewSlot?.findMany !== 'function') return [];

  const slots = await prisma.interviewSlot.findMany({
    where: {
      vacancyId,
      isActive: true,
      scheduledAt: { gt: new Date() }
    },
    orderBy: { scheduledAt: 'asc' },
    take: limit,
    include: {
      _count: { select: { interviews: { where: { status: { not: InterviewStatus.CANCELLED } } } } }
    }
  });

  return slots
    .filter((s) => s._count.interviews < s.maxCapacity)
    .map((s) => ({
      id: s.id,
      scheduledAt: s.scheduledAt,
      label: buildSlotLabel(s.scheduledAt),
      maxCapacity: s.maxCapacity,
      booked: s._count.interviews
    }));
}

/**
 * Busca la entrevista activa de un candidato (estado SCHEDULED o CONFIRMED).
 */
export async function getActiveInterview(prisma, candidateId) {
  return prisma.interview.findFirst({
    where: {
      candidateId,
      status: { in: [InterviewStatus.SCHEDULED, InterviewStatus.CONFIRMED] }
    },
    include: { slot: true },
    orderBy: { createdAt: 'desc' }
  });
}

// ---------------------------------------------------------------------------
// Operaciones de agendamiento
// ---------------------------------------------------------------------------

/**
 * Agenda al candidato en un slot específico.
 * Valida cupo disponible antes de insertar.
 * Retorna { ok, interview, error }.
 */
export async function bookInterview(prisma, candidateId, slotId) {
  const slot = await prisma.interviewSlot.findUnique({
    where: { id: slotId },
    include: {
      _count: { select: { interviews: { where: { status: { not: InterviewStatus.CANCELLED } } } } }
    }
  });

  if (!slot) return { ok: false, error: 'slot_not_found' };
  if (!slot.isActive) return { ok: false, error: 'slot_inactive' };
  if (slot._count.interviews >= slot.maxCapacity) return { ok: false, error: 'slot_full' };
  if (slot.scheduledAt <= new Date()) return { ok: false, error: 'slot_expired' };

  await prisma.interview.updateMany({
    where: {
      candidateId,
      status: { in: [InterviewStatus.SCHEDULED, InterviewStatus.CONFIRMED] }
    },
    data: { status: InterviewStatus.CANCELLED, statusUpdatedAt: new Date(), statusUpdatedBy: 'bot_reschedule' }
  });

  const interview = await prisma.interview.create({
    data: {
      candidateId,
      slotId,
      status: InterviewStatus.SCHEDULED,
      statusUpdatedAt: new Date(),
      statusUpdatedBy: 'bot_flow'
    },
    include: { slot: true }
  });

  await prisma.candidate.update({
    where: { id: candidateId },
    data: { currentStep: ConversationStep.SCHEDULING_INTERVIEW }
  });

  return { ok: true, interview };
}

/**
 * Confirma asistencia del candidato a su entrevista activa.
 */
export async function confirmInterview(prisma, candidateId) {
  const active = await getActiveInterview(prisma, candidateId);
  if (!active) return { ok: false, error: 'no_active_interview' };

  await prisma.interview.update({
    where: { id: active.id },
    data: {
      status: InterviewStatus.CONFIRMED,
      statusUpdatedAt: new Date(),
      statusUpdatedBy: 'candidate_whatsapp'
    }
  });

  return { ok: true, interview: active };
}

/**
 * Cancela la entrevista activa del candidato.
 */
export async function cancelInterview(prisma, candidateId) {
  const active = await getActiveInterview(prisma, candidateId);
  if (!active) return { ok: false, error: 'no_active_interview' };

  await prisma.interview.update({
    where: { id: active.id },
    data: {
      status: InterviewStatus.CANCELLED,
      statusUpdatedAt: new Date(),
      statusUpdatedBy: 'candidate_whatsapp'
    }
  });

  await prisma.candidate.update({
    where: { id: candidateId },
    data: { currentStep: ConversationStep.ASK_CV }
  });

  return { ok: true };
}

/**
 * Marca la entrevista como RESCHEDULED.
 */
export async function rescheduleInterview(prisma, candidateId) {
  const active = await getActiveInterview(prisma, candidateId);
  if (!active) return { ok: false, error: 'no_active_interview' };

  await prisma.interview.update({
    where: { id: active.id },
    data: {
      status: InterviewStatus.RESCHEDULED,
      statusUpdatedAt: new Date(),
      statusUpdatedBy: 'candidate_whatsapp'
    }
  });

  await prisma.candidate.update({
    where: { id: candidateId },
    data: { currentStep: ConversationStep.SCHEDULING_INTERVIEW }
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Recordatorio 1 hora antes
// ---------------------------------------------------------------------------

/**
 * Construye el mensaje de recordatorio de entrevista.
 * @param {string|null} candidateName  Nombre completo del candidato (o null)
 * @param {Date}        scheduledAt    Fecha/hora del slot
 * @param {string|null} address        Dirección del lugar de entrevista (o null)
 */
export function buildReminderMessage(candidateName, scheduledAt, address = null) {
  const nombre = candidateName ? `, ${candidateName.split(' ')[0]}` : '';
  const hora = buildSlotLabel(scheduledAt);
  const lugar = address ? `\nRecuerda presentarte en: ${address}` : '';
  return `¡Hola${nombre}! Te recordamos que tienes una entrevista programada hoy ${hora}.${lugar}\n\n¿Confirmas tu asistencia? Responde *Sí* para confirmar o *No* si no puedes asistir.`;
}

/**
 * Registra el momento en que se envió el recordatorio para una entrevista.
 */
export async function markReminderSent(prisma, interviewId) {
  return prisma.interview.update({
    where: { id: interviewId },
    data: { reminderSentAt: new Date() }
  });
}

/**
 * Procesa la respuesta del candidato al recordatorio de entrevista.
 */
export async function processReminderResponse(prisma, candidateId, text) {
  const n = String(text || '').trim().toLowerCase();
  const active = await getActiveInterview(prisma, candidateId);
  if (!active) return { action: 'unknown', interview: null };
  if (!active.reminderSentAt) return { action: 'unknown', interview: active };

  const isConfirm    = /^(s[ií]|claro|listo|ok|confirmo|voy|ah[ií] estoy|de acuerdo|dale)/.test(n);
  const isCancel     = /^(no|nop|negativo|no puedo|no voy|no asisto|cancelo)/.test(n);
  const isReschedule = /(reprogramar|cambiar|otro d[ií]a|otra hora|no puedo hoy|imposible hoy)/.test(n);

  if (isConfirm) {
    await prisma.interview.update({
      where: { id: active.id },
      data: { status: InterviewStatus.CONFIRMED, reminderResponse: ReminderResponse.CONFIRMED, statusUpdatedAt: new Date(), statusUpdatedBy: 'reminder_response' }
    });
    return { action: 'confirmed', interview: active };
  }

  if (isReschedule) {
    await prisma.interview.update({
      where: { id: active.id },
      data: { status: InterviewStatus.RESCHEDULED, reminderResponse: ReminderResponse.RESCHEDULED, statusUpdatedAt: new Date(), statusUpdatedBy: 'reminder_response' }
    });
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { currentStep: ConversationStep.SCHEDULING_INTERVIEW }
    });
    return { action: 'rescheduled', interview: active };
  }

  if (isCancel) {
    await prisma.interview.update({
      where: { id: active.id },
      data: { status: InterviewStatus.CANCELLED, reminderResponse: ReminderResponse.CANCELLED, statusUpdatedAt: new Date(), statusUpdatedBy: 'reminder_response' }
    });
    return { action: 'cancelled', interview: active };
  }

  await prisma.interview.update({
    where: { id: active.id },
    data: { reminderResponse: ReminderResponse.NO_RESPONSE }
  });
  return { action: 'unknown', interview: active };
}

// ---------------------------------------------------------------------------
// Dispatcher de recordatorios (llamado desde reminder.js polling)
// ---------------------------------------------------------------------------

/**
 * Busca entrevistas que deben recibir recordatorio en la próxima ventana.
 * Criterios: status SCHEDULED/CONFIRMED, scheduledAt entre ahora+50min y ahora+70min,
 * reminderSentAt IS NULL.
 */
export async function findInterviewsDueForReminder(prisma) {
  if (typeof prisma.interview?.findMany !== 'function') return [];

  const now = new Date();
  const windowStart = new Date(now.getTime() + 50 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 70 * 60 * 1000);

  return prisma.interview.findMany({
    where: {
      status: { in: [InterviewStatus.SCHEDULED, InterviewStatus.CONFIRMED] },
      reminderSentAt: null,
      slot: { scheduledAt: { gte: windowStart, lte: windowEnd } }
    },
    include: {
      candidate: { select: { id: true, phone: true, fullName: true } },
      slot: { include: { vacancy: { select: { operationAddress: true } } } }
    }
  });
}
