import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDispatchWorkedTime,
  formatDispatchMinutes
} from '../src/modules/dispatch-attendance/domain/attendanceWorkdayPolicy.js';

test('descuenta únicamente el almuerzo realmente marcado', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T13:00:00.000Z',
    departureAt: '2026-07-25T22:00:00.000Z',
    expectedStartAt: '2026-07-25T13:00:00.000Z',
    breakStartAt: '2026-07-25T17:00:00.000Z',
    breakEndAt: '2026-07-25T18:00:00.000Z'
  });
  assert.equal(result.grossWorkedMinutes, 540);
  assert.equal(result.unpaidBreakMinutesDeducted, 60);
  assert.equal(result.workedMinutes, 480);
});

test('sin almuerzo marcado, todo el tiempo efectivo cuenta', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T13:00:00.000Z',
    departureAt: '2026-07-25T21:00:00.000Z',
    expectedStartAt: '2026-07-25T13:00:00.000Z'
  });
  assert.equal(result.workedMinutes, 480);
  assert.equal(result.unpaidBreakMinutesDeducted, 0);
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
});

test('rechaza una salida anterior a la llegada', () => {
  assert.throws(() => calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T14:00:00.000Z',
    departureAt: '2026-07-25T13:00:00.000Z'
  }), /attendance_work_departure_before_arrival/);
});

test('formatea minutos para la interfaz', () => {
  assert.equal(formatDispatchMinutes(480), '8 h');
  assert.equal(formatDispatchMinutes(510), '8 h 30 min');
  assert.equal(formatDispatchMinutes(45), '45 min');
});
