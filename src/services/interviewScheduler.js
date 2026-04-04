/**
 * interviewScheduler.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * Reglas de negocio:
 *  1. Solo se ofrecen slots con al menos MIN_HOURS_ADVANCE horas de anticipación
 *     desde el momento actual (por defecto 6h).
 *  2. Para poder enviar recordatorio 1h antes, el slot debe estar > 24h en el
 *     futuro (ventana activa de Meta) O dentro de la ventana activa actual
 *     (el candidato escribió hace <24h y la entrevista está dentro de ese window).
 *  3. Si el slot está fuera de la ventana de 24h Y dentro de ella hay alguna
 *     interacción posible (ej. el bot puede escribirle antes de las 24h para
 *     abrir una nueva ventana), se marca reminderWindowClosed=true y se aplica
 *     la estrategia de extensión de ventana.
 *  4. El bot NUNCA ofrece dos slots en el mismo mensaje. Ofrece el más cercano
 *     válido y, si el candidato rechaza, ofrece el siguiente.
 */

const MIN_HOURS_ADVANCE = 6;
const REMINDER_HOURS_BEFORE = 1;
const WA_WINDOW_HOURS = 24;

/**
 * Genera la fecha y hora exacta de un InterviewSlot a partir de hoy.
 *
 * @param {object} slot — InterviewSlot de Prisma
 * @param {Date} fromDate — fecha de referencia (ahora)
 * @returns {Date|null}
 */
function resolveSlotDate(slot, fromDate) {
  const [startH, startM] = slot.startTime.split(':').map(Number);

  if (slot.specificDate) {
    const d = new Date(slot.specificDate);
    d.setHours(startH, startM, 0, 0);
    return d;
  }

  if (slot.dayOfWeek !== null && slot.dayOfWeek !== undefined) {
    const dayMap = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 0 }; // lunes=1 ... domingo=0
    const targetDay = dayMap[slot.dayOfWeek];
    const now = new Date(fromDate);
    let diff = targetDay - now.getDay();
    if (diff < 0) diff += 7;
    if (diff === 0) diff = 7; // si es hoy, el próximo ocurre en 7 días
    const d = new Date(now);
    d.setDate(d.getDate() + diff);
    d.setHours(startH, startM, 0, 0);
    return d;
  }

  return null;
}

/**
 * Calcula si la entrevista está dentro de la ventana activa de WhatsApp.
 * La ventana activa = el candidato escribió hace menos de 24h.
 *
 * @param {Date} interviewDate
 * @param {Date|null} lastInboundAt
 * @returns {{ inWindow: boolean, windowExpiresAt: Date|null }}
 */
function checkWaWindow(interviewDate, lastInboundAt) {
  if (!lastInboundAt) return { inWindow: false, windowExpiresAt: null };
  const windowExpiresAt = new Date(lastInboundAt.getTime() + WA_WINDOW_HOURS * 3600 * 1000);
  const reminderTime = new Date(interviewDate.getTime() - REMINDER_HOURS_BEFORE * 3600 * 1000);
  return {
    inWindow: reminderTime < windowExpiresAt,
    windowExpiresAt
  };
}

/**
 * Estrategia de extensión de ventana.
 * Si el recordatorio cae fuera de la ventana de 24h, calculamos en qué
 * momento el bot debe mandar un mensaje proactivo de "recordatorio anticipado"
 * para abrir una nueva ventana, de modo que el recordatorio real (1h antes)
 * ya quepa dentro de esa nueva ventana.
 *
 * Esquema:
 *   T0 = hora actual
 *   T_entrevista = hora de la entrevista
 *   T_reminder = T_entrevista - 1h
 *
 *   Si T_reminder >= T0 + 24h:
 *     → necesitamos un mensaje previo que abra ventana.
 *     → El mensaje previo debe enviarse en: T_reminder - 23h
 *       (24h antes del reminder, para que cuando llegue el reminder
 *        la ventana esté viva).
 *     → Si ese momento ya pasó (T0 > T_reminder - 23h), el bot
 *        envía el mensaje de re-enganche lo antes posible.
 *
 * @param {Date} interviewDate
 * @param {Date} now
 * @returns {{ needsWindowExtension: boolean, extendAt: Date|null }}
 */
export function calculateWindowExtension(interviewDate, now) {
  const reminderTime = new Date(interviewDate.getTime() - REMINDER_HOURS_BEFORE * 3600 * 1000);
  const minWindowStart = new Date(reminderTime.getTime() - (WA_WINDOW_HOURS - 1) * 3600 * 1000);

  if (reminderTime.getTime() < now.getTime() + WA_WINDOW_HOURS * 3600 * 1000) {
    return { needsWindowExtension: false, extendAt: null };
  }

  const extendAt = minWindowStart > now ? minWindowStart : new Date(now.getTime() + 5 * 60 * 1000);
  return { needsWindowExtension: true, extendAt };
}

/**
 * Obtiene los slots disponibles para una vacante, ordenados por fecha.
 * Filtra slots ya llenos.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} vacancyId
 * @param {Date} now
 * @returns {Promise<Array<{ slot: object, date: Date, candidateCount: number, available: boolean }>>}
 */
async function getAvailableSlots(prisma, vacancyId, now) {
  const slots = await prisma.interviewSlot.findMany({
    where: { vacancyId, isActive: true },
    include: {
      _count: { select: { bookings: { where: { status: { in: ['SCHEDULED', 'CONFIRMED'] } } } } }
    }
  });

  const resolved = slots
    .map((slot) => {
      const date = resolveSlotDate(slot, now);
      if (!date) return null;
      const candidateCount = slot._count.bookings;
      const available = candidateCount < slot.maxCandidates;
      return { slot, date, candidateCount, available };
    })
    .filter(Boolean)
    .filter((s) => s.available)
    .sort((a, b) => a.date - b.date);

  return resolved;
}

/**
 * Obtiene el próximo slot válido para ofrecer al candidato,
 * considerando anticipación mínima y estrategia de ventana 24h.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} vacancyId
 * @param {Date|null} lastInboundAt — última vez que el candidato escribió
 * @param {Date} [now] — inyectable para tests
 * @param {number} [skipCount=0] — cuántos slots ya fueron rechazados (para ofrecer el siguiente)
 * @returns {Promise<{
 *   slot: object|null,
 *   date: Date|null,
 *   windowOk: boolean,
 *   windowExtension: { needsWindowExtension: boolean, extendAt: Date|null }|null
 * }>}
 */
export async function getNextAvailableSlot(prisma, vacancyId, lastInboundAt, now = new Date(), skipCount = 0) {
  const available = await getAvailableSlots(prisma, vacancyId, now);

  // Filtrar por anticipación mínima
  const withAdvance = available.filter((s) => {
    const diffHours = (s.date.getTime() - now.getTime()) / 3600000;
    return diffHours >= MIN_HOURS_ADVANCE;
  });

  if (!withAdvance.length) return { slot: null, date: null, windowOk: false, windowExtension: null };

  const target = withAdvance[skipCount] || withAdvance[withAdvance.length - 1];
  const { inWindow } = checkWaWindow(target.date, lastInboundAt);
  const windowExtension = inWindow ? null : calculateWindowExtension(target.date, now);

  return {
    slot: target.slot,
    date: target.date,
    windowOk: inWindow,
    windowExtension
  };
}

/**
 * Crea un InterviewBooking en la DB.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} candidateId
 * @param {string} vacancyId
 * @param {string} slotId
 * @param {Date} scheduledAt
 * @param {boolean} reminderWindowClosed
 * @returns {Promise<object>}
 */
export async function createBooking(prisma, candidateId, vacancyId, slotId, scheduledAt, reminderWindowClosed = false) {
  return prisma.interviewBooking.create({
    data: { candidateId, vacancyId, slotId, scheduledAt, reminderWindowClosed }
  });
}

/**
 * Cancela todos los bookings activos de un candidato para una vacante.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} candidateId
 */
export async function cancelCandidateBookings(prisma, candidateId) {
  return prisma.interviewBooking.updateMany({
    where: { candidateId, status: { in: ['SCHEDULED', 'CONFIRMED'] } },
    data: { status: 'CANCELLED' }
  });
}

/**
 * Formatea una fecha de entrevista en español natural.
 * Ej: "martes 8 de abril a las 10:00 a.m."
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatInterviewDate(date) {
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const day = days[date.getDay()];
  const dateNum = date.getDate();
  const month = months[date.getMonth()];
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const period = hours < 12 ? 'a.m.' : 'p.m.';
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${day} ${dateNum} de ${month} a las ${displayHour}:${minutes} ${period}`;
}
