import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVacancyBody, hasValidInterviewConfig, buildWeeklyInterviewSlots } from '../src/routes/admin.js';

test('parseVacancyBody mantiene una sola hora para varios dias seleccionados', () => {
  const data = parseVacancyBody({
    title: 'Auxiliar',
    operationId: 'op-1',
    schedulingEnabled: 'true',
    slotScheduleMode: 'UNIFORM',
    slotDays: ['1', '3'],
    slotStartTime: '08:30',
    slotMaxCandidates: '12'
  });

  assert.equal(data.slotScheduleMode, 'UNIFORM');
  assert.deepEqual(data.slotDays, [1, 3]);
  assert.equal(hasValidInterviewConfig(data), true);
  assert.deepEqual(buildWeeklyInterviewSlots('vacancy-1', data), [
    { vacancyId: 'vacancy-1', dayOfWeek: 1, startTime: '08:30', maxCandidates: 12, isActive: true },
    { vacancyId: 'vacancy-1', dayOfWeek: 3, startTime: '08:30', maxCandidates: 12, isActive: true }
  ]);
});

test('parseVacancyBody acepta horas distintas por dia', () => {
  const data = parseVacancyBody({
    title: 'Coordinador',
    operationId: 'op-2',
    schedulingEnabled: 'true',
    slotScheduleMode: 'BY_DAY',
    slotDays: ['2', '4'],
    slotDayTime_2: '09:00',
    slotDayTime_4: '14:30',
    slotMaxCandidates: '8'
  });

  assert.equal(data.slotScheduleMode, 'BY_DAY');
  assert.equal(hasValidInterviewConfig(data), true);
  assert.deepEqual(data.slotConfigs, [
    { dayOfWeek: 2, startTime: '09:00', maxCandidates: 8 },
    { dayOfWeek: 4, startTime: '14:30', maxCandidates: 8 }
  ]);
});

test('hasValidInterviewConfig falla si falta hora especifica para un dia seleccionado', () => {
  const data = parseVacancyBody({
    title: 'Coordinador',
    operationId: 'op-2',
    schedulingEnabled: 'true',
    slotScheduleMode: 'BY_DAY',
    slotDays: ['2', '4'],
    slotDayTime_2: '09:00',
    slotMaxCandidates: '8'
  });

  assert.equal(hasValidInterviewConfig(data), false);
});
