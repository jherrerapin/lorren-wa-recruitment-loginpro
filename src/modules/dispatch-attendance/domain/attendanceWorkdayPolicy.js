function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label}_invalid`);
  return number;
}

export function calculateDispatchWorkedTime(input = {}) {
  const arrivalAt = validDate(input.arrivalAt, 'attendance_work_arrival');
  const departureAt = validDate(input.departureAt, 'attendance_work_departure');
  if (departureAt.getTime() < arrivalAt.getTime()) {
    throw new Error('attendance_work_departure_before_arrival');
  }

  const configuredBreakMinutes = nonNegativeInteger(
    input.unpaidBreakMinutes ?? 0,
    'attendance_work_unpaid_break_minutes'
  );
  const grossWorkedMinutes = Math.floor((departureAt.getTime() - arrivalAt.getTime()) / 60_000);
  const unpaidBreakMinutesDeducted = Math.min(configuredBreakMinutes, grossWorkedMinutes);
  const workedMinutes = Math.max(0, grossWorkedMinutes - unpaidBreakMinutesDeducted);

  let plannedWorkedMinutes = null;
  let differenceFromPlannedMinutes = null;
  if (input.expectedStartAt && input.expectedEndAt) {
    const expectedStartAt = validDate(input.expectedStartAt, 'attendance_work_expected_start');
    const expectedEndAt = validDate(input.expectedEndAt, 'attendance_work_expected_end');
    if (expectedEndAt.getTime() >= expectedStartAt.getTime()) {
      const plannedGrossMinutes = Math.floor((expectedEndAt.getTime() - expectedStartAt.getTime()) / 60_000);
      plannedWorkedMinutes = Math.max(0, plannedGrossMinutes - Math.min(configuredBreakMinutes, plannedGrossMinutes));
      differenceFromPlannedMinutes = workedMinutes - plannedWorkedMinutes;
    }
  }

  return {
    grossWorkedMinutes,
    unpaidBreakMinutesDeducted,
    workedMinutes,
    plannedWorkedMinutes,
    differenceFromPlannedMinutes
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
