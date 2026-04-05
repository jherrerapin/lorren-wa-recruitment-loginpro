/**
 * interviewScheduler.js
 *
 * Reglas de negocio:
 *  1. Solo se ofrecen slots con al menos MIN_HOURS_ADVANCE horas de anticipacion.
 *  2. El scheduler usa hora Colombia de forma consistente para resolver dias y horas.
 *  3. Si el candidato rechaza un horario, se ofrece el siguiente slot valido.
 *  4. El recordatorio operativo de entrevista esta previsto 1 hora antes.
 */

const MIN_HOURS_ADVANCE = 6;
const REMINDER_HOURS_BEFORE = 1;
const WA_WINDOW_HOURS = 24;
const COLOMBIA_OFFSET_MS = 5 * 60 * 60 * 1000;

function toColombiaClock(date) {
  return new Date(date.getTime() - COLOMBIA_OFFSET_MS);
}

function getColombiaParts(date) {
  const shifted = toColombiaClock(date);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    dayOfWeek: shifted.getUTCDay(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes()
  };
}

function createColombiaDate(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute, 0, 0));
}

function mapStoredDayToJs(dayOfWeek) {
  return dayOfWeek === 6 ? 0 : dayOfWeek + 1;
}

function resolveSlotDates(slot, fromDate, maxOccurrences = 4) {
  const [startH, startM] = String(slot.startTime || '00:00').split(':').map(Number);

  if (slot.specificDate) {
    const parts = getColombiaParts(new Date(slot.specificDate));
    return [createColombiaDate(parts.year, parts.month, parts.day, startH, startM)];
  }

  if (slot.dayOfWeek === null || slot.dayOfWeek === undefined) return [];

  const current = getColombiaParts(fromDate);
  const targetDay = mapStoredDayToJs(slot.dayOfWeek);
  const matches = [];

  for (let offset = 0; offset < 35 && matches.length < maxOccurrences; offset += 1) {
    const candidateBase = new Date(Date.UTC(current.year, current.month - 1, current.day + offset, 0, 0, 0, 0));
    if (candidateBase.getUTCDay() !== targetDay) continue;
    matches.push(createColombiaDate(
      candidateBase.getUTCFullYear(),
      candidateBase.getUTCMonth() + 1,
      candidateBase.getUTCDate(),
      startH,
      startM
    ));
  }

  return matches;
}

function checkWaWindow(interviewDate, lastInboundAt) {
  if (!lastInboundAt) return { inWindow: false, windowExpiresAt: null };
  const windowExpiresAt = new Date(lastInboundAt.getTime() + WA_WINDOW_HOURS * 3600 * 1000);
  const reminderTime = getInterviewReminderAt(interviewDate);
  return {
    inWindow: reminderTime < windowExpiresAt,
    windowExpiresAt
  };
}

export function calculateWindowExtension(interviewDate, now) {
  const reminderTime = getInterviewReminderAt(interviewDate);
  const minWindowStart = new Date(reminderTime.getTime() - (WA_WINDOW_HOURS - 1) * 3600 * 1000);

  if (reminderTime.getTime() < now.getTime() + WA_WINDOW_HOURS * 3600 * 1000) {
    return { needsWindowExtension: false, extendAt: null };
  }

  const extendAt = minWindowStart > now ? minWindowStart : new Date(now.getTime() + 5 * 60 * 1000);
  return { needsWindowExtension: true, extendAt };
}

export function getInterviewReminderAt(interviewDate) {
  return new Date(interviewDate.getTime() - REMINDER_HOURS_BEFORE * 3600 * 1000);
}

async function getAvailableSlots(prisma, vacancyId, now) {
  const slots = await prisma.interviewSlot.findMany({
    where: { vacancyId, isActive: true },
    include: {
      bookings: {
        where: { status: { in: ['SCHEDULED', 'CONFIRMED'] } },
        select: { scheduledAt: true }
      }
    }
  });

  return slots
    .flatMap((slot) => resolveSlotDates(slot, now).map((date) => {
      const candidateCount = slot.bookings.filter((booking) => new Date(booking.scheduledAt).getTime() === date.getTime()).length;
      return {
        slot,
        date,
        candidateCount,
        available: candidateCount < slot.maxCandidates
      };
    }))
    .filter((entry) => entry.available)
    .sort((a, b) => a.date - b.date);
}

function enrichOfferSlot(entry, lastInboundAt, now, skipCount) {
  const { inWindow } = checkWaWindow(entry.date, lastInboundAt);
  return {
    ...entry,
    formattedDate: formatInterviewDate(entry.date),
    reminderAt: getInterviewReminderAt(entry.date),
    skipCount,
    windowOk: inWindow,
    windowExtension: inWindow ? null : calculateWindowExtension(entry.date, now)
  };
}

export async function listOfferableSlots(prisma, vacancyId, lastInboundAt, now = new Date()) {
  const available = await getAvailableSlots(prisma, vacancyId, now);
  return available
    .filter((entry) => ((entry.date.getTime() - now.getTime()) / 3600000) >= MIN_HOURS_ADVANCE)
    .map((entry, index) => enrichOfferSlot(entry, lastInboundAt, now, index));
}

function emptySlotResult() {
  return {
    slot: null,
    date: null,
    reminderAt: null,
    formattedDate: null,
    skipCount: 0,
    windowOk: false,
    windowExtension: null
  };
}

function matchesSlotContext(entry, offeredSlot) {
  if (!offeredSlot) return false;
  if (offeredSlot.slot?.id && entry.slot.id === offeredSlot.slot.id) {
    if (!offeredSlot.date) return true;
    return entry.date.getTime() === new Date(offeredSlot.date).getTime();
  }
  if (offeredSlot.slotId) {
    if (entry.slot.id !== offeredSlot.slotId) return false;
    if (!offeredSlot.scheduledAt) return true;
    return entry.date.getTime() === new Date(offeredSlot.scheduledAt).getTime();
  }
  return false;
}

export async function hydrateOfferedSlot(prisma, vacancyId, lastInboundAt, offeredSlot, now = new Date()) {
  const offers = await listOfferableSlots(prisma, vacancyId, lastInboundAt, now);
  if (!offers.length) return emptySlotResult();
  return offers.find((entry) => matchesSlotContext(entry, offeredSlot)) || offers[0];
}

export async function getNextAvailableSlot(prisma, vacancyId, lastInboundAt, now = new Date(), skipCount = 0) {
  const offers = await listOfferableSlots(prisma, vacancyId, lastInboundAt, now);
  if (!offers.length) return emptySlotResult();
  return offers[skipCount] || offers[offers.length - 1];
}

export async function getNextAvailableSlotAfter(prisma, vacancyId, lastInboundAt, currentOffer, now = new Date()) {
  const offers = await listOfferableSlots(prisma, vacancyId, lastInboundAt, now);
  if (!offers.length) return emptySlotResult();

  const currentIndex = offers.findIndex((entry) => matchesSlotContext(entry, currentOffer));
  if (currentIndex < 0) return offers[0];
  return offers[currentIndex + 1] || emptySlotResult();
}

export async function createBooking(prisma, candidateId, vacancyId, slotId, scheduledAt, reminderWindowClosed = false) {
  const existing = await prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      vacancyId,
      slotId,
      scheduledAt,
      status: { in: ['SCHEDULED', 'CONFIRMED'] }
    }
  });

  if (existing) return existing;

  return prisma.interviewBooking.create({
    data: { candidateId, vacancyId, slotId, scheduledAt, reminderWindowClosed }
  });
}

export async function cancelCandidateBookings(prisma, candidateId, replacementStatus = 'CANCELLED') {
  return prisma.interviewBooking.updateMany({
    where: { candidateId, status: { in: ['SCHEDULED', 'CONFIRMED'] } },
    data: { status: replacementStatus }
  });
}

export function formatInterviewDate(date) {
  const shifted = toColombiaClock(date);
  const days = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const day = days[shifted.getUTCDay()];
  const dateNum = shifted.getUTCDate();
  const month = months[shifted.getUTCMonth()];
  const hours = shifted.getUTCHours();
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
  const period = hours < 12 ? 'a.m.' : 'p.m.';
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${day} ${dateNum} de ${month} a las ${displayHour}:${minutes} ${period}`;
}
