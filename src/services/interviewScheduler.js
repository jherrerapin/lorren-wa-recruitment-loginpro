/**
 * interviewScheduler.js
 *
 * Reglas de negocio:
 *  1. Solo se ofrecen slots con al menos MIN_HOURS_ADVANCE horas de anticipacion.
 *  2. El scheduler usa hora Colombia de forma consistente para resolver dias y horas.
 *  3. Si el candidato rechaza un horario, se ofrece el siguiente slot valido.
 *  4. El recordatorio operativo de entrevista esta previsto 40 minutos antes.
 */

const MIN_HOURS_ADVANCE = 6;
const REMINDER_MINUTES_BEFORE = 40;
const WA_WINDOW_HOURS = 24;
const COLOMBIA_OFFSET_MS = 5 * 60 * 60 * 1000;
const ACTIVE_BOOKING_STATUSES = ['SCHEDULED', 'CONFIRMED'];

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

function getCurrentColombiaWeekBounds(fromDate) {
  const current = getColombiaParts(fromDate);
  const mondayOffset = current.dayOfWeek === 0 ? -6 : 1 - current.dayOfWeek;
  const weekStart = new Date(Date.UTC(current.year, current.month - 1, current.day + mondayOffset, 0, 0, 0, 0));
  const weekEnd = new Date(Date.UTC(
    weekStart.getUTCFullYear(),
    weekStart.getUTCMonth(),
    weekStart.getUTCDate() + 6,
    23,
    59,
    59,
    999
  ));
  return { weekStart, weekEnd };
}

function isInCurrentColombiaWeek(date, fromDate) {
  const parts = getColombiaParts(date);
  const candidateDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0));
  const { weekStart, weekEnd } = getCurrentColombiaWeekBounds(fromDate);
  return candidateDay >= weekStart && candidateDay <= weekEnd;
}

function resolveSlotDates(slot, fromDate, maxOccurrences = 4) {
  const [startH, startM] = String(slot.startTime || '00:00').split(':').map(Number);

  if (slot.specificDate) {
    const date = new Date(slot.specificDate);
    if (slot.currentWeekOnly && !isInCurrentColombiaWeek(date, fromDate)) return [];
    const parts = getColombiaParts(date);
    return [createColombiaDate(parts.year, parts.month, parts.day, startH, startM)];
  }

  if (slot.dayOfWeek === null || slot.dayOfWeek === undefined) return [];

  const current = getColombiaParts(fromDate);
  const targetDay = mapStoredDayToJs(slot.dayOfWeek);
  const matches = [];

  const maxSearchDays = slot.currentWeekOnly ? 7 : 35;
  const currentWeekBounds = slot.currentWeekOnly ? getCurrentColombiaWeekBounds(fromDate) : null;

  for (let offset = 0; offset < maxSearchDays && matches.length < maxOccurrences; offset += 1) {
    const candidateBase = new Date(Date.UTC(current.year, current.month - 1, current.day + offset, 0, 0, 0, 0));
    if (candidateBase.getUTCDay() !== targetDay) continue;
    if (currentWeekBounds && (candidateBase < currentWeekBounds.weekStart || candidateBase > currentWeekBounds.weekEnd)) continue;
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
  return new Date(interviewDate.getTime() - REMINDER_MINUTES_BEFORE * 60 * 1000);
}

async function getAvailableSlots(prisma, vacancyId, now) {
  const slots = await prisma.interviewSlot.findMany({
    where: { vacancyId, isActive: true },
    include: {
      bookings: {
        where: { status: { in: ACTIVE_BOOKING_STATUSES } },
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

export async function listOfferableSlots(
  prisma,
  vacancyId,
  lastInboundAt,
  now = new Date(),
  minHoursAdvance = MIN_HOURS_ADVANCE
) {
  const available = await getAvailableSlots(prisma, vacancyId, now);
  return available
    .filter((entry) => ((entry.date.getTime() - now.getTime()) / 3600000) >= minHoursAdvance)
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

async function findExactActiveBooking(prisma, candidateId, vacancyId, slotId, scheduledAt) {
  return prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      vacancyId,
      slotId,
      scheduledAt,
      status: { in: ACTIVE_BOOKING_STATUSES }
    }
  });
}

async function findAnyActiveBooking(prisma, candidateId) {
  return prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      status: { in: ACTIVE_BOOKING_STATUSES }
    },
    orderBy: { scheduledAt: 'asc' }
  });
}

export async function createBooking(prisma, candidateId, vacancyId, slotId, scheduledAt, reminderWindowClosed = false, replacementStatus = 'RESCHEDULED') {
  const exactExisting = await findExactActiveBooking(prisma, candidateId, vacancyId, slotId, scheduledAt);
  if (exactExisting) return exactExisting;

  await prisma.interviewBooking.updateMany({
    where: {
      candidateId,
      status: { in: ACTIVE_BOOKING_STATUSES }
    },
    data: {
      status: replacementStatus,
      reminderWindowClosed: true
    }
  });

  try {
    return await prisma.interviewBooking.create({
      data: { candidateId, vacancyId, slotId, scheduledAt, reminderWindowClosed }
    });
  } catch (error) {
    const active = await findAnyActiveBooking(prisma, candidateId);
    if (active) return active;
    throw error;
  }
}

export async function cancelCandidateBookings(prisma, candidateId, replacementStatus = 'CANCELLED') {
  return prisma.interviewBooking.updateMany({
    where: { candidateId, status: { in: ACTIVE_BOOKING_STATUSES } },
    data: { status: replacementStatus, reminderWindowClosed: true }
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
