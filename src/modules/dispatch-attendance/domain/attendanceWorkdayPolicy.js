export const STANDARD_DISPATCH_WORKDAY_MINUTES = 7 * 60;
export const STANDARD_DISPATCH_BREAK_MINUTES = 60;
export const INCOMPLETE_DISPATCH_BREAK_PENALTY_MINUTES = 90;

export const DISPATCH_BREAK_STATUS = Object.freeze({
  NONE: 'NONE',
  COMPLETE: 'COMPLETE',
  INCOMPLETE: 'INCOMPLETE'
});

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function optionalDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return validDate(value, label);
}

function minutesBetween(startAt, endAt) {
  return Math.max(0, Math.floor((endAt.getTime() - startAt.getTime()) / 60_000));
}

function clampDate(value, minimum, maximum) {
  if (value.getTime() < minimum.getTime()) return minimum;
  if (value.getTime() > maximum.getTime()) return maximum;
  return value;
}

export function resolveDispatchEffectiveWorkStart(input = {}) {
  const arrivalAt = validDate(input.arrivalAt, 'attendance_work_arrival');
  const expectedStartAt = optionalDate(input.expectedStartAt, 'attendance_work_expected_start');
  const recognizeEarlyArrival = input.recognizeEarlyArrival === true;

  if (!expectedStartAt || recognizeEarlyArrival || arrivalAt.getTime() >= expectedStartAt.getTime()) {
    return arrivalAt;
  }
  return expectedStartAt;
}

function resolveBreakCalculation({ breakStartAt, breakEndAt, effectiveWorkStartAt, departureAt, grossWorkedMinutes }) {
  if (!breakStartAt) {
    return {
      breakStatus: DISPATCH_BREAK_STATUS.NONE,
      actualBreakMinutes: 0,
      unpaidBreakMinutesDeducted: 0,
      shortBreakMinutesCredited: STANDARD_DISPATCH_BREAK_MINUTES,
      breakPenaltyMinutes: 0
    };
  }

  if (!breakEndAt) {
    const deducted = Math.min(INCOMPLETE_DISPATCH_BREAK_PENALTY_MINUTES, grossWorkedMinutes);
    return {
      breakStatus: DISPATCH_BREAK_STATUS.INCOMPLETE,
      actualBreakMinutes: null,
      unpaidBreakMinutesDeducted: deducted,
      shortBreakMinutesCredited: 0,
      breakPenaltyMinutes: deducted
    };
  }

  const effectiveBreakStart = clampDate(breakStartAt, effectiveWorkStartAt, departureAt);
  const effectiveBreakEnd = clampDate(breakEndAt, effectiveWorkStartAt, departureAt);
  const actualBreakMinutes = effectiveBreakEnd.getTime() > effectiveBreakStart.getTime()
    ? minutesBetween(effectiveBreakStart, effectiveBreakEnd)
    : 0;

  return {
    breakStatus: DISPATCH_BREAK_STATUS.COMPLETE,
    actualBreakMinutes,
    unpaidBreakMinutesDeducted: actualBreakMinutes,
    shortBreakMinutesCredited: Math.max(0, STANDARD_DISPATCH_BREAK_MINUTES - actualBreakMinutes),
    breakPenaltyMinutes: 0
  };
}

export function calculateDispatchWorkedTime(input = {}) {
  const arrivalAt = validDate(input.arrivalAt, 'attendance_work_arrival');
  const departureAt = validDate(input.departureAt, 'attendance_work_departure');
  if (departureAt.getTime() < arrivalAt.getTime()) {
    throw new Error('attendance_work_departure_before_arrival');
  }

  const expectedStartAt = optionalDate(input.expectedStartAt, 'attendance_work_expected_start');
  const expectedEndAt = optionalDate(input.expectedEndAt, 'attendance_work_expected_end');
  const breakStartAt = optionalDate(input.breakStartAt, 'attendance_work_break_start');
  const breakEndAt = optionalDate(input.breakEndAt, 'attendance_work_break_end');
  if (breakEndAt && !breakStartAt) throw new Error('attendance_work_break_start_required');
  if (breakStartAt && breakEndAt && breakEndAt.getTime() < breakStartAt.getTime()) {
    throw new Error('attendance_work_break_end_before_start');
  }

  const effectiveWorkStartAt = resolveDispatchEffectiveWorkStart({
    arrivalAt,
    expectedStartAt,
    recognizeEarlyArrival: input.recognizeEarlyArrival
  });
  const recordedSpanMinutes = minutesBetween(arrivalAt, departureAt);
  const grossWorkedMinutes = minutesBetween(effectiveWorkStartAt, departureAt);
  const earlyMinutesExcluded = Math.max(0, minutesBetween(arrivalAt, effectiveWorkStartAt));
  const breakCalculation = resolveBreakCalculation({
    breakStartAt,
    breakEndAt,
    effectiveWorkStartAt,
    departureAt,
    grossWorkedMinutes
  });
  const workedMinutes = Math.max(0, grossWorkedMinutes - breakCalculation.unpaidBreakMinutesDeducted);
  const ordinaryWorkedMinutes = Math.min(workedMinutes, STANDARD_DISPATCH_WORKDAY_MINUTES);
  const overtimeMinutes = Math.max(0, workedMinutes - STANDARD_DISPATCH_WORKDAY_MINUTES);

  return {
    recordedSpanMinutes,
    effectiveWorkStartAt,
    grossWorkedMinutes,
    earlyMinutesExcluded,
    ...breakCalculation,
    workedMinutes,
    ordinaryWorkedMinutes,
    overtimeMinutes,
    plannedWorkedMinutes: STANDARD_DISPATCH_WORKDAY_MINUTES,
    differenceFromPlannedMinutes: workedMinutes - STANDARD_DISPATCH_WORKDAY_MINUTES,
    expectedEndAt
  };
}

export function formatDispatchMinutes(value) {
  const total = Number(value);
  if (!Number.isFinite(total) || total < 0) return 'Sin calcular';
  const minutes = Math.trunc(total);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder} min`;
  if (!remainder) return `${hours} h`;
  return `${hours} h ${remainder} min`;
}