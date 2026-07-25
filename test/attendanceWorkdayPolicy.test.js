import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDispatchWorkedTime,
  formatDispatchMinutes
} from '../src/modules/dispatch-attendance/domain/attendanceWorkdayPolicy.js';

test('descuenta el descanso no remunerado del tiempo bruto', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: new Date('2026-07-25T13:00:00.000Z'),
    departureAt: new Date('2026-07-25T22:00:00.000Z'),
    expectedStartAt: new Date('2026-07-25T13:00:00.000Z'),
    expectedEndAt: new Date('2026-07-25T22:00:00.000Z'),
    unpaidBreakMinutes: 60
  });
  assert.deepEqual(result, {
    grossWorkedMinutes: 540,
    unpaidBreakMinutesDeducted: 60,
    workedMinutes: 480,
    plannedWorkedMinutes: 480,
    differenceFromPlannedMinutes: 0
  });
});

test('sin descanso, el tiempo bruto y neto coinciden', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T13:00:00.000Z',
    departureAt: '2026-07-25T21:00:00.000Z',
    unpaidBreakMinutes: 0
  });
  assert.equal(result.grossWorkedMinutes, 480);
  assert.equal(result.workedMinutes, 480);
  assert.equal(result.unpaidBreakMinutesDeducted, 0);
});

test('soporta jornadas que terminan al día siguiente', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T23:00:00.000Z',
    departureAt: '2026-07-26T08:00:00.000Z',
    unpaidBreakMinutes: 30
  });
  assert.equal(result.grossWorkedMinutes, 540);
  assert.equal(result.workedMinutes, 510);
});

test('nunca descuenta más descanso que el tiempo transcurrido', () => {
  const result = calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T13:00:00.000Z',
    departureAt: '2026-07-25T13:20:00.000Z',
    unpaidBreakMinutes: 60
  });
  assert.equal(result.unpaidBreakMinutesDeducted, 20);
  assert.equal(result.workedMinutes, 0);
});

test('rechaza una salida anterior a la llegada', () => {
  assert.throws(() => calculateDispatchWorkedTime({
    arrivalAt: '2026-07-25T14:00:00.000Z',
    departureAt: '2026-07-25T13:00:00.000Z',
    unpaidBreakMinutes: 0
  }), /attendance_work_departure_before_arrival/);
});

test('formatea minutos para la interfaz', () => {
  assert.equal(formatDispatchMinutes(480), '8 h');
  assert.equal(formatDispatchMinutes(510), '8 h 30 min');
  assert.equal(formatDispatchMinutes(45), '45 min');
});
