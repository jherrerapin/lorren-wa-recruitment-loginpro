import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const viewSource = fs.readFileSync(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');

test('las tarjetas no muestran explicaciones extensas de jornada o almuerzo', () => {
  assert.doesNotMatch(viewSource, /class="policy-note"/);
  assert.doesNotMatch(viewSource, /La jornada ordinaria es de 7 horas trabajadas/);
  assert.doesNotMatch(viewSource, /assignment\.breakLabel/);
  assert.doesNotMatch(viewSource, /assignment\.ordinaryWorkedLabel/);
  assert.doesNotMatch(viewSource, /assignment\.shortBreakMinutesCredited/);
});

test('el portal conserva solo información operativa útil', () => {
  assert.match(viewSource, /assignment\.arrivalReportedLabel/);
  assert.match(viewSource, /assignment\.departureReportedLabel/);
  assert.match(viewSource, /assignment\.breakStartLabel/);
  assert.match(viewSource, /assignment\.breakEndLabel/);
  assert.match(viewSource, /assignment\.workedLabel/);
  assert.match(viewSource, /assignment\.overtimeLabel/);
  assert.match(viewSource, /data-mark-type="<%= assignment\.breakActionType %>"/);
});
