export const PAYROLL_CONCEPT_CODES = Object.freeze([
  'HEDO', 'HENO', 'HEDD', 'HEND', 'HEDF', 'HENF',
  'RNO', 'RDD', 'RND', 'RDF', 'RNF', 'RDDC', 'RNDC', 'RDFC', 'RNFC'
]);

export const PAYROLL_COMPENSATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  COMPENSATED: 'COMPENSATED',
  NOT_COMPENSATED: 'NOT_COMPENSATED'
});

export const MIN_OVERTIME_RECOGNITION_MINUTES = 30;

export const DEFAULT_PAYROLL_POLICY = Object.freeze({
  weeklyOrdinaryMinutes: 42 * 60,
  dailyOrdinaryMinutes: 7 * 60,
  maxDailyOvertimeMinutes: 2 * 60,
  maxWeeklyOvertimeMinutes: 12 * 60,
  nightStartMinute: 19 * 60,
  nightEndMinute: 6 * 60,
  weekStartsOn: 1,
  restDay: 0,
  recognizeEarlyArrival: false,
  incompleteBreakPenaltyMinutes: 90,
  holidaySundayPriority: 'HOLIDAY',
  timezone: 'America/Bogota',
  version: 'CO-2026-07'
});

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function finiteInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

export function normalizePayrollPolicy(source = {}) {
  return {
    weeklyOrdinaryMinutes: finiteInteger(source.weeklyOrdinaryMinutes, DEFAULT_PAYROLL_POLICY.weeklyOrdinaryMinutes, { min: 60, max: DEFAULT_PAYROLL_POLICY.weeklyOrdinaryMinutes }),
    dailyOrdinaryMinutes: finiteInteger(source.dailyOrdinaryMinutes, DEFAULT_PAYROLL_POLICY.dailyOrdinaryMinutes, { min: 60, max: DEFAULT_PAYROLL_POLICY.dailyOrdinaryMinutes }),
    maxDailyOvertimeMinutes: finiteInteger(source.maxDailyOvertimeMinutes, DEFAULT_PAYROLL_POLICY.maxDailyOvertimeMinutes, { min: 0, max: 12 * 60 }),
    maxWeeklyOvertimeMinutes: finiteInteger(source.maxWeeklyOvertimeMinutes, DEFAULT_PAYROLL_POLICY.maxWeeklyOvertimeMinutes, { min: 0, max: 7 * 24 * 60 }),
    nightStartMinute: finiteInteger(source.nightStartMinute, DEFAULT_PAYROLL_POLICY.nightStartMinute, { min: 0, max: 1439 }),
    nightEndMinute: finiteInteger(source.nightEndMinute, DEFAULT_PAYROLL_POLICY.nightEndMinute, { min: 0, max: 1439 }),
    weekStartsOn: DEFAULT_PAYROLL_POLICY.weekStartsOn,
    restDay: finiteInteger(source.restDay, DEFAULT_PAYROLL_POLICY.restDay, { min: 0, max: 6 }),
    recognizeEarlyArrival: source.recognizeEarlyArrival === true,
    incompleteBreakPenaltyMinutes: finiteInteger(source.incompleteBreakPenaltyMinutes, DEFAULT_PAYROLL_POLICY.incompleteBreakPenaltyMinutes, { min: 0, max: 8 * 60 }),
    holidaySundayPriority: 'HOLIDAY',
    timezone: 'America/Bogota',
    version: typeof source.version === 'string' && source.version.trim() ? source.version.trim().slice(0, 80) : DEFAULT_PAYROLL_POLICY.version
  };
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOnlyUtc(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null;
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addDateKeyDays(dateKey, days) {
  const date = dateOnlyUtc(dateKey);
  if (!date) throw new Error('payroll_date_key_invalid');
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

export function bogotaDateKey(value) {
  const date = validDate(value);
  if (!date) return null;
  return new Date(date.getTime() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

function bogotaClockParts(value) {
  const date = validDate(value);
  if (!date) return null;
  const shifted = new Date(date.getTime() - BOGOTA_OFFSET_MS);
  return {
    dateKey: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay()
  };
}

export function bogotaDayStart(dateKey) {
  const date = dateOnlyUtc(dateKey);
  if (!date) throw new Error('payroll_date_key_invalid');
  return new Date(date.getTime() + BOGOTA_OFFSET_MS);
}

export function payrollWeekStartKey(dateKey, weekStartsOn = 1) {
  const date = dateOnlyUtc(dateKey);
  if (!date) throw new Error('payroll_date_key_invalid');
  const target = finiteInteger(weekStartsOn, 1, { min: 0, max: 6 });
  const delta = (date.getUTCDay() - target + 7) % 7;
  date.setUTCDate(date.getUTCDate() - delta);
  return date.toISOString().slice(0, 10);
}

function moveToMonday(dateKey) {
  const date = dateOnlyUtc(dateKey);
  const weekday = date.getUTCDay();
  const days = weekday === 1 ? 0 : (8 - weekday) % 7;
  return addDateKeyDays(dateKey, days);
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function colombianHolidayKeys(year) {
  const holidays = new Set([
    `${year}-01-01`, `${year}-05-01`, `${year}-07-20`, `${year}-08-07`, `${year}-12-08`, `${year}-12-25`
  ]);
  [
    `${year}-01-06`, `${year}-03-19`, `${year}-06-29`, `${year}-08-15`,
    `${year}-10-12`, `${year}-11-01`, `${year}-11-11`
  ].forEach((key) => holidays.add(moveToMonday(key)));

  const easter = easterSunday(year);
  holidays.add(addDateKeyDays(easter, -3));
  holidays.add(addDateKeyDays(easter, -2));
  holidays.add(addDateKeyDays(easter, 43));
  holidays.add(addDateKeyDays(easter, 64));
  holidays.add(addDateKeyDays(easter, 71));
  return holidays;
}

function latestMark(session, markType) {
  return (Array.isArray(session?.marks) ? session.marks : [])
    .filter((mark) => mark?.markType === markType)
    .map((mark) => ({ ...mark, moment: validDate(mark.clientCapturedAt || mark.serverReceivedAt) }))
    .filter((mark) => mark.moment)
    .sort((left, right) => right.moment.getTime() - left.moment.getTime())[0] || null;
}

function pushNovelty(target, code, message, metadata = {}) {
  if (target.some((item) => item.code === code && item.dateKey === metadata.dateKey && item.sessionId === metadata.sessionId)) return;
  target.push({ code, message, blocking: metadata.blocking !== false, ...metadata });
}

function sessionMinuteRecords(session, policy, novelties) {
  const arrivalAt = validDate(session?.arrivalReportedAt);
  const departureAt = validDate(session?.departureReportedAt);
  if (!arrivalAt || !departureAt || departureAt <= arrivalAt) {
    pushNovelty(novelties, 'INCOMPLETE_SESSION', 'La jornada no tiene entrada y salida válidas.', {
      sessionId: session?.id || null,
      blocking: true
    });
    return [];
  }

  const expectedStartAt = validDate(session?.expectedStartAt);
  const effectiveStartAt = policy.recognizeEarlyArrival || !expectedStartAt || arrivalAt >= expectedStartAt
    ? arrivalAt
    : expectedStartAt;
  const totalMinutes = Math.max(0, Math.floor((departureAt.getTime() - effectiveStartAt.getTime()) / MINUTE_MS));
  let minutes = Array.from({ length: totalMinutes }, (_unused, index) => new Date(effectiveStartAt.getTime() + index * MINUTE_MS));

  const breakStart = latestMark(session, 'BREAK_START')?.moment || null;
  const breakEnd = latestMark(session, 'BREAK_END')?.moment || null;
  if (breakStart && breakEnd && breakEnd > breakStart) {
    minutes = minutes.filter((minute) => minute < breakStart || minute >= breakEnd);
  } else if (breakStart && !breakEnd) {
    const penalty = policy.incompleteBreakPenaltyMinutes;
    let removed = 0;
    minutes = minutes.filter((minute) => {
      const shouldRemove = minute >= breakStart && removed < penalty;
      if (shouldRemove) removed += 1;
      return !shouldRemove;
    });
    if (removed < penalty) minutes.splice(Math.max(0, minutes.length - (penalty - removed)), penalty - removed);
    pushNovelty(novelties, 'INCOMPLETE_BREAK', 'El almuerzo quedó abierto y requiere revisión.', {
      sessionId: session.id,
      dateKey: bogotaDateKey(arrivalAt),
      blocking: true
    });
  }

  const storedWorkedMinutes = Number.isInteger(session?.workedMinutes) && session.workedMinutes >= 0
    ? session.workedMinutes
    : null;
  if (storedWorkedMinutes !== null && storedWorkedMinutes !== minutes.length) {
    pushNovelty(novelties, 'WORKED_MINUTES_MISMATCH', 'El tiempo guardado no coincide con las marcaciones calculadas.', {
      sessionId: session.id,
      dateKey: bogotaDateKey(arrivalAt),
      blocking: true,
      storedWorkedMinutes,
      calculatedWorkedMinutes: minutes.length
    });
    if (minutes.length > storedWorkedMinutes) minutes = minutes.slice(0, storedWorkedMinutes);
  }

  const validationStatus = String(session?.validationStatus || '').toUpperCase();
  if (!['AUTO_VALIDATED', 'MANUAL_VALIDATED'].includes(validationStatus)) {
    pushNovelty(novelties, 'SESSION_NOT_VALIDATED', 'La jornada todavía no ha sido validada para nómina.', {
      sessionId: session.id,
      dateKey: bogotaDateKey(arrivalAt),
      blocking: true
    });
  }

  const workdayKey = bogotaDateKey(arrivalAt);
  return minutes.map((timestamp) => ({ timestamp, session, workdayKey }));
}

function isNightMinute(minuteOfDay, policy) {
  if (policy.nightStartMinute === policy.nightEndMinute) return true;
  if (policy.nightStartMinute > policy.nightEndMinute) {
    return minuteOfDay >= policy.nightStartMinute || minuteOfDay < policy.nightEndMinute;
  }
  return minuteOfDay >= policy.nightStartMinute && minuteOfDay < policy.nightEndMinute;
}

function conceptForMinute({ overtime, night, holiday, rest, compensated }) {
  if (overtime) {
    if (holiday) return night ? 'HENF' : 'HEDF';
    if (rest) return night ? 'HEND' : 'HEDD';
    return night ? 'HENO' : 'HEDO';
  }
  if (holiday) return night ? 'RNF' : 'RDF';
  if (rest) return compensated ? (night ? 'RNDC' : 'RDDC') : (night ? 'RND' : 'RDD');
  return night ? 'RNO' : null;
}

function emptyConceptMinutes() {
  return Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0]));
}

function workerIdentity(session) {
  const worker = session?.assignment?.worker || {};
  return {
    workerId: worker.id || session?.assignment?.workerId || 'unknown',
    fullName: worker.fullName || 'Auxiliar sin nombre',
    documentType: worker.documentType || '',
    documentNumber: worker.documentNumber || '',
    phone: worker.phone || ''
  };
}

function clientIdentity(session) {
  const point = session?.assignment?.serviceRequest?.operationPoint || {};
  const client = point.client || {};
  return {
    clientId: client.id || point.clientId || 'unknown',
    clientName: client.name || session?.assignment?.serviceRequest?.clientName || 'Cliente sin nombre',
    operationPointId: point.id || null,
    operationPointName: point.name || session?.assignment?.serviceRequest?.operationPointName || 'Operación sin nombre'
  };
}

function compensationStatusFor(map, workerId, dateKey) {
  const value = map instanceof Map ? map.get(`${workerId}|${dateKey}`) : null;
  return Object.values(PAYROLL_COMPENSATION_STATUS).includes(value)
    ? value
    : PAYROLL_COMPENSATION_STATUS.PENDING;
}

function localMinuteKey(parts) {
  return `${parts.dateKey}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function inRange(dateKey, range) {
  return dateKey >= range.from && dateKey <= range.to;
}

function findOverlappingSessionIds(rawRecords, novelties) {
  const sessions = new Map();
  for (const record of rawRecords) {
    const sessionId = record?.session?.id;
    if (!sessionId || sessions.has(sessionId)) continue;
    const arrivalAt = validDate(record.session.arrivalReportedAt);
    const departureAt = validDate(record.session.departureReportedAt);
    if (!arrivalAt || !departureAt || departureAt <= arrivalAt) continue;
    sessions.set(sessionId, {
      sessionId,
      arrivalAt,
      departureAt,
      workdayKey: record.workdayKey || bogotaDateKey(arrivalAt)
    });
  }

  const ordered = [...sessions.values()].sort((left, right) => {
    const arrivalDelta = left.arrivalAt.getTime() - right.arrivalAt.getTime();
    if (arrivalDelta) return arrivalDelta;
    return left.sessionId.localeCompare(right.sessionId);
  });
  const accepted = [];
  const rejected = new Set();
  for (const current of ordered) {
    const overlapsAccepted = accepted.some((previous) => (
      current.arrivalAt.getTime() < previous.departureAt.getTime()
      && current.departureAt.getTime() > previous.arrivalAt.getTime()
    ));
    if (!overlapsAccepted) {
      accepted.push(current);
      continue;
    }
    rejected.add(current.sessionId);
    pushNovelty(novelties, 'OVERLAPPING_ASSIGNMENTS', 'Existen jornadas superpuestas para el mismo auxiliar.', {
      dateKey: current.workdayKey,
      sessionId: current.sessionId,
      blocking: true
    });
  }
  return rejected;
}

function ensureWorkerSummary(map, identity) {
  if (!map.has(identity.workerId)) {
    map.set(identity.workerId, {
      ...identity,
      totalMinutes: 0,
      ordinaryMinutes: 0,
      overtimeMinutes: 0,
      unrecognizedOvertimeMinutes: 0,
      conceptMinutes: emptyConceptMinutes(),
      daily: new Map(),
      novelties: []
    });
  }
  return map.get(identity.workerId);
}

function ensureDaily(summary, dateKey) {
  if (!summary.daily.has(dateKey)) {
    summary.daily.set(dateKey, {
      dateKey,
      totalMinutes: 0,
      ordinaryMinutes: 0,
      overtimeMinutes: 0,
      unrecognizedOvertimeMinutes: 0,
      conceptMinutes: emptyConceptMinutes(),
      clientNames: new Set(),
      operationNames: new Set(),
      civilDateKeys: new Set(),
      holidayDateKeys: new Set(),
      restDateKeys: new Set(),
      isHoliday: false,
      isRestDay: false,
      compensationDateKey: null,
      compensationStatus: null,
      novelties: []
    });
  }
  return summary.daily.get(dateKey);
}

export function minutesToDecimalHours(minutes, decimals = 2) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return 0;
  return Number((value / 60).toFixed(decimals));
}

export function formatPayrollMinutes(minutes) {
  const value = Math.max(0, Math.trunc(Number(minutes) || 0));
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  return `${hours} h ${String(remainder).padStart(2, '0')} min`;
}

export function calculatePayrollConceptReport(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const range = input.range || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(range.from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(range.to || '')) || range.from > range.to) {
    throw new Error('payroll_range_invalid');
  }

  const policiesByClientId = input.policiesByClientId instanceof Map ? input.policiesByClientId : new Map();
  const compensationByWorkerDate = input.compensationByWorkerDate instanceof Map ? input.compensationByWorkerDate : new Map();
  const holidayCache = new Map();
  const recordsByWorker = new Map();
  const reportNoveltyMap = new Map();

  for (const session of sessions) {
    const worker = workerIdentity(session);
    const client = clientIdentity(session);
    const policy = normalizePayrollPolicy(policiesByClientId.get(client.clientId) || input.defaultPolicy || {});
    const sessionNovelties = [];
    const records = sessionMinuteRecords(session, policy, sessionNovelties).map((record) => ({
      ...record,
      worker,
      client,
      policy
    }));
    if (!recordsByWorker.has(worker.workerId)) recordsByWorker.set(worker.workerId, []);
    recordsByWorker.get(worker.workerId).push(...records);
    if (!reportNoveltyMap.has(worker.workerId)) reportNoveltyMap.set(worker.workerId, []);
    reportNoveltyMap.get(worker.workerId).push(...sessionNovelties);
  }

  const summaries = new Map();
  for (const [workerId, rawRecords] of recordsByWorker) {
    rawRecords.sort((left, right) => left.timestamp - right.timestamp);
    const dailyOrdinary = new Map();
    const weeklyOrdinary = new Map();
    const rawDailyOvertime = new Map();
    const classifiedRecords = [];
    const workerNovelties = reportNoveltyMap.get(workerId) || [];
    const identity = rawRecords[0]?.worker || { workerId, fullName: 'Auxiliar sin nombre', documentType: '', documentNumber: '', phone: '' };
    const summary = ensureWorkerSummary(summaries, identity);
    summary.novelties.push(...workerNovelties);
    const overlappingSessionIds = findOverlappingSessionIds(rawRecords, summary.novelties);
    const seenMinutes = new Set();

    for (const record of rawRecords) {
      if (overlappingSessionIds.has(record.session.id)) continue;
      const parts = bogotaClockParts(record.timestamp);
      if (!parts) continue;
      const workdayKey = record.workdayKey || parts.dateKey;
      const minuteKey = localMinuteKey(parts);
      if (seenMinutes.has(minuteKey)) {
        pushNovelty(summary.novelties, 'OVERLAPPING_ASSIGNMENTS', 'Existen jornadas superpuestas para el mismo auxiliar.', {
          dateKey: workdayKey,
          sessionId: record.session.id,
          blocking: true
        });
        continue;
      }
      seenMinutes.add(minuteKey);

      const weekKey = payrollWeekStartKey(workdayKey, record.policy.weekStartsOn);
      const dayOrdinary = dailyOrdinary.get(workdayKey) || 0;
      const weekOrdinary = weeklyOrdinary.get(weekKey) || 0;
      const rawOvertime = dayOrdinary >= record.policy.dailyOrdinaryMinutes
        || weekOrdinary >= record.policy.weeklyOrdinaryMinutes;
      if (rawOvertime) {
        rawDailyOvertime.set(workdayKey, (rawDailyOvertime.get(workdayKey) || 0) + 1);
      } else {
        dailyOrdinary.set(workdayKey, dayOrdinary + 1);
        weeklyOrdinary.set(weekKey, weekOrdinary + 1);
      }
      classifiedRecords.push({ ...record, parts, workdayKey, weekKey, rawOvertime });
    }

    const recognizedOvertimeWorkdays = new Set(
      [...rawDailyOvertime.entries()]
        .filter(([, minutes]) => minutes >= MIN_OVERTIME_RECOGNITION_MINUTES)
        .map(([workdayKey]) => workdayKey)
    );
    const recognizedDailyOvertime = new Map();
    const recognizedWeeklyOvertime = new Map();

    for (const [workdayKey, minutes] of rawDailyOvertime) {
      if (minutes >= MIN_OVERTIME_RECOGNITION_MINUTES) continue;
      pushNovelty(summary.novelties, 'OVERTIME_BELOW_MINIMUM', `El exceso de ${minutes} minuto(s) no alcanzó el mínimo de ${MIN_OVERTIME_RECOGNITION_MINUTES} minutos para reconocerse como hora extra.`, {
        dateKey: workdayKey,
        blocking: false,
        overtimeMinutes: minutes,
        minimumMinutes: MIN_OVERTIME_RECOGNITION_MINUTES
      });
    }

    for (const record of classifiedRecords) {
      const { parts, workdayKey, weekKey, rawOvertime } = record;
      const overtime = rawOvertime && recognizedOvertimeWorkdays.has(workdayKey);
      const unrecognizedOvertime = rawOvertime && !overtime;
      if (overtime) {
        recognizedDailyOvertime.set(workdayKey, (recognizedDailyOvertime.get(workdayKey) || 0) + 1);
        recognizedWeeklyOvertime.set(weekKey, (recognizedWeeklyOvertime.get(weekKey) || 0) + 1);
      }

      if (!inRange(workdayKey, range)) continue;

      const year = Number(parts.dateKey.slice(0, 4));
      if (!holidayCache.has(year)) holidayCache.set(year, colombianHolidayKeys(year));
      const holiday = holidayCache.get(year).has(parts.dateKey);
      const rest = parts.weekday === record.policy.restDay && !holiday;
      const compensationStatus = rest
        ? compensationStatusFor(compensationByWorkerDate, workerId, parts.dateKey)
        : null;
      const compensated = rest && compensationStatus === PAYROLL_COMPENSATION_STATUS.COMPENSATED;
      const night = isNightMinute(parts.hour * 60 + parts.minute, record.policy);
      const concept = unrecognizedOvertime
        ? null
        : conceptForMinute({ overtime, night, holiday, rest, compensated });

      summary.totalMinutes += 1;
      if (overtime) summary.overtimeMinutes += 1;
      else if (unrecognizedOvertime) summary.unrecognizedOvertimeMinutes += 1;
      else summary.ordinaryMinutes += 1;
      if (concept) summary.conceptMinutes[concept] += 1;

      const daily = ensureDaily(summary, workdayKey);
      daily.totalMinutes += 1;
      if (overtime) daily.overtimeMinutes += 1;
      else if (unrecognizedOvertime) daily.unrecognizedOvertimeMinutes += 1;
      else daily.ordinaryMinutes += 1;
      if (concept) daily.conceptMinutes[concept] += 1;
      daily.clientNames.add(record.client.clientName);
      daily.operationNames.add(record.client.operationPointName);
      daily.civilDateKeys.add(parts.dateKey);
      if (holiday) daily.holidayDateKeys.add(parts.dateKey);
      if (rest) daily.restDateKeys.add(parts.dateKey);
      daily.isHoliday = daily.isHoliday || holiday;
      daily.isRestDay = daily.isRestDay || rest;
      if (rest) {
        daily.compensationDateKey = daily.compensationDateKey || parts.dateKey;
        daily.compensationStatus = compensationStatus;
        if (compensationStatus === PAYROLL_COMPENSATION_STATUS.PENDING) {
          pushNovelty(summary.novelties, 'COMPENSATION_PENDING', 'Define si el día de descanso obligatorio fue compensado.', {
            dateKey: parts.dateKey,
            sessionId: record.session.id,
            blocking: true
          });
        }
      }
    }

    for (const [dateKey, minutes] of recognizedDailyOvertime) {
      const policy = rawRecords.find((record) => record.workdayKey === dateKey)?.policy || DEFAULT_PAYROLL_POLICY;
      if (minutes > policy.maxDailyOvertimeMinutes) {
        pushNovelty(summary.novelties, 'DAILY_OVERTIME_LIMIT_EXCEEDED', 'Las horas extra del día superan el límite configurado.', {
          dateKey,
          blocking: true,
          overtimeMinutes: minutes
        });
      }
    }
    for (const [weekKey, minutes] of recognizedWeeklyOvertime) {
      const policy = rawRecords.find((record) => payrollWeekStartKey(record.workdayKey || bogotaDateKey(record.timestamp), record.policy.weekStartsOn) === weekKey)?.policy || DEFAULT_PAYROLL_POLICY;
      if (minutes > policy.maxWeeklyOvertimeMinutes) {
        pushNovelty(summary.novelties, 'WEEKLY_OVERTIME_LIMIT_EXCEEDED', 'Las horas extra de la semana superan el límite configurado.', {
          dateKey: weekKey,
          blocking: true,
          overtimeMinutes: minutes
        });
      }
    }
  }

  const rows = [...summaries.values()]
    .map((summary) => ({
      ...summary,
      conceptHours: Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, minutesToDecimalHours(summary.conceptMinutes[code])])),
      totalHours: minutesToDecimalHours(summary.totalMinutes),
      ordinaryHours: minutesToDecimalHours(summary.ordinaryMinutes),
      overtimeHours: minutesToDecimalHours(summary.overtimeMinutes),
      unrecognizedOvertimeHours: minutesToDecimalHours(summary.unrecognizedOvertimeMinutes),
      daily: [...summary.daily.values()]
        .sort((left, right) => left.dateKey.localeCompare(right.dateKey))
        .map((daily) => ({
          ...daily,
          clientNames: [...daily.clientNames],
          operationNames: [...daily.operationNames],
          civilDateKeys: [...daily.civilDateKeys],
          holidayDateKeys: [...daily.holidayDateKeys],
          restDateKeys: [...daily.restDateKeys],
          conceptHours: Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, minutesToDecimalHours(daily.conceptMinutes[code])])),
          totalHours: minutesToDecimalHours(daily.totalMinutes),
          ordinaryHours: minutesToDecimalHours(daily.ordinaryMinutes),
          overtimeHours: minutesToDecimalHours(daily.overtimeMinutes),
          unrecognizedOvertimeHours: minutesToDecimalHours(daily.unrecognizedOvertimeMinutes)
        })),
      status: summary.novelties.some((item) => item.blocking) ? 'CON_NOVEDADES' : 'CALCULADO',
      exportable: !summary.novelties.some((item) => item.blocking)
    }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName, 'es'));

  const totals = {
    workers: rows.length,
    totalMinutes: rows.reduce((sum, row) => sum + row.totalMinutes, 0),
    ordinaryMinutes: rows.reduce((sum, row) => sum + row.ordinaryMinutes, 0),
    overtimeMinutes: rows.reduce((sum, row) => sum + row.overtimeMinutes, 0),
    unrecognizedOvertimeMinutes: rows.reduce((sum, row) => sum + row.unrecognizedOvertimeMinutes, 0),
    exportableWorkers: rows.filter((row) => row.exportable).length,
    workersWithNovelties: rows.filter((row) => !row.exportable).length,
    conceptMinutes: emptyConceptMinutes()
  };
  for (const code of PAYROLL_CONCEPT_CODES) {
    totals.conceptMinutes[code] = rows.reduce((sum, row) => sum + row.conceptMinutes[code], 0);
  }
  totals.totalHours = minutesToDecimalHours(totals.totalMinutes);
  totals.ordinaryHours = minutesToDecimalHours(totals.ordinaryMinutes);
  totals.overtimeHours = minutesToDecimalHours(totals.overtimeMinutes);
  totals.unrecognizedOvertimeHours = minutesToDecimalHours(totals.unrecognizedOvertimeMinutes);
  totals.conceptHours = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, minutesToDecimalHours(totals.conceptMinutes[code])]));

  return { range, rows, totals, conceptCodes: PAYROLL_CONCEPT_CODES };
}
