import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPATCH_BREAK_STATUS,
  INCOMPLETE_DISPATCH_BREAK_PENALTY_MINUTES,
  STANDARD_DISPATCH_WORKDAY_MINUTES,
  calculateDispatchWorkedTime,
  formatDispatchMinutes
} from '../src/modules/dispatch-attendance/domain/attendanceWorkdayPolicy.js';

test('una jornada de ocho horas con una hora de almuerzo produce siete horas ordinarias', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T13:00:00.000Z',
    departureAt: '2026-07-25T21:00:00.000Z',
    expectedStartAt: '2026-07-25T13:00:00.000Z',
    breakStartAt: '2026-07-25T17:00:00.000Z',
    breakEndAt: '2026-07-25T18:00:00.000Z'
  });
  assert.equal(result.grossWorkedMinutes, 480);
  assert.equal(result.unpaidBreakMinutesDeducted, 60);
  assert.equal(result.workedMinutes, 420);
  assert.equal(result.ordinaryWorkedMinutes, 420);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.breakStatus, DISPATCH_BREAK_STATUS.COMPLETE);
});

test('sin almuerzo, la hora disponible cuenta como trabajo y como extra sobre siete horas', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T13:00:00.000Z',
    departureAt: '2026-07-25T21:00:00.000Z',
    expectedStartAt: '2026-07-25T13:00:00.000Z'
  });
  assert.equal(result.workedMinutes, 480);
  assert.equal(result.unpaidBreakMinutesDeducted, 0);
  assert.equal(result.shortBreakMinutesCredited, 60);
  assert.equal(result.ordinaryWorkedMinutes, STANDARD_DISPATCH_WORKDAY_MINUTES);
  assert.equal(result.overtimeMinutes, 60);
  assert.equal(result.breakStatus, DISPATCH_BREAK_STATUS.NONE);
});

test('un almuerzo menor a una hora suma la diferencia al tiempo trabajado', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T13:00:00.000Z',
    departureAt: '2026-07-25T21:00:00.000Z',
    expectedStartAt: '2026-07-25T13:00:00.000Z',
    breakStartAt: '2026-07-25T17:00:00.000Z',
    breakEndAt: '2026-07-25T17:30:00.000Z'
  });
  assert.equal(result.actualBreakMinutes, 30);
  assert.equal(result.shortBreakMinutesCredited, 30);
  assert.equal(result.workedMinutes, 450);
  assert.equal(result.overtimeMinutes, 30);
});

test('un almuerzo iniciado sin finalización descuenta una hora y media sin impedir el cálculo', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T13:00:00.000Z',
    departureAt: '2026-07-25T21:00:00.000Z',
    expectedStartAt: '2026-07-25T13:00:00.000Z',
    breakStartAt: '2026-07-25T17:00:00.000Z'
  });
  assert.equal(result.breakStatus, DISPATCH_BREAK_STATUS.INCOMPLETE);
  assert.equal(result.breakPenaltyMinutes, INCOMPLETE_DISPATCH_BREAK_PENALTY_MINUTES);
  assert.equal(result.unpaidBreakMinutesDeducted, 90);
  assert.equal(result.workedMinutes, 390);
  assert.equal(result.overtimeMinutes, 0);
});

test('registra la llegada anticipada pero cuenta desde el inicio programado', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T12:30:00.000Z',
    departureAt: '2026-07-25T21:00:00.000Z',
    expectedStartAt: '2026-07-25T13:00:00.000Z'
  });
  assert.equal(result.recordedSpanMinutes, 510);
  assert.equal(result.earlyMinutesExcluded, 30);
  assert.equal(result.workedMinutes, 480);
  assert.equal(result.overtimeMinutes, 60);
});

test('el coordinador puede reconocer el tiempo anticipado', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T12:30:00.000Z',
    departureAt: '2026-07-25T21:00:00.000Z',
    expectedStartAt: '2026-07-25T13:00:00.000Z',
    recognizeEarlyArrival: true
  });
  assert.equal(result.earlyMinutesExcluded, 0);
  assert.equal(result.workedMinutes, 510);
  assert.equal(result.overtimeMinutes, 90);
});

test('soporta una jornada que termina al día siguiente', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T23:00:00.000Z',
    departureAt: '2026-07-26T08:00:00.000Z',
    breakStartAt: '2026-07-26T03:00:00.000Z',
    breakEndAt: '2026-07-26T03:30:00.000Z'
  });
  assert.equal(result.grossWorkedMinutes, 540);
  assert.equal(result.workedMinutes, 510);
  assert.equal(result.overtimeMinutes, 90);
});

test('rechaza una salida anterior a la llegada', () => {
  assert.throws(() => calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T14:00:00.000Z',
    departureAt: '2026-07-25T13:00:00.000Z'
  }), /attendance_work_departure_before_arrival/);
});

test('formatea minutos para la interfaz', () => {
  assert.equal(formatDispatchMinutes(420), '7 h');
  assert.equal(formatDispatchMinutes(480), '8 h');
  assert.equal(formatDispatchMinutes(510), '8 h 30 min');
  assert.equal(formatDispatchMinutes(45), '45 min');
});