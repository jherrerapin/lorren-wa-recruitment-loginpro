import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const multiselect = fs.readFileSync(new URL('../src/public/lorren-searchable-multiselect.js', import.meta.url), 'utf8');
const navigation = fs.readFileSync(new URL('../src/services/adminNavigation.js', import.meta.url), 'utf8');
const attendance = fs.readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');
const payroll = fs.readFileSync(new URL('../src/views/operacionesNomina.ejs', import.meta.url), 'utf8');

test('la búsqueda seleccionable comparte una única autoridad y exige tres caracteres', () => {
  assert.match(multiselect, /const MIN_QUERY_LENGTH = 3/);
  assert.match(multiselect, /function searchableCheckboxMultiSelect/);
  assert.match(multiselect, /query\.length >= MIN_QUERY_LENGTH/);
  assert.match(multiselect, /type = 'checkbox'/);
  assert.match(multiselect, /lorren-search-multiselect-chip/);
});

test('Asistencia transforma su buscador existente en selección múltiple sin duplicar filtros backend', () => {
  assert.match(attendance, /input name="q"/);
  assert.match(multiselect, /installAttendanceMultiSelect/);
  assert.match(multiselect, /input\.removeAttribute\('name'\)/);
  assert.match(multiselect, /\[data-attendance-card\]/);
  assert.match(multiselect, /card\.hidden = selectedKeys\.size > 0/);
});

test('Gestión de Tiempo integra buscador y lista de checks en un solo control', () => {
  assert.match(payroll, /class="worker-picker"/);
  assert.match(payroll, /type="checkbox" name="workerId"/);
  assert.match(payroll, /input id="search" name="search"/);
  assert.match(multiselect, /installPayrollMultiSelect/);
  assert.match(multiselect, /menu\.prepend\(searchInput\)/);
  assert.match(multiselect, /searchField\.remove\(\)/);
  assert.match(multiselect, /option\.input\.checked/);
});

test('el nuevo comportamiento se inyecta solo en Asistencia y Gestión de Tiempo', () => {
  assert.match(navigation, /SEARCHABLE_MULTISELECT_SCRIPT = '\/public\/lorren-searchable-multiselect\.js'/);
  assert.match(navigation, /path === ATTENDANCE_PATH/);
  assert.match(navigation, /path\.startsWith\(PAYROLL_PATH\)/);
  assert.match(navigation, /ensureSearchableMultiselectScript/);
});

test('el multiselect elimina listeners heredados del typeahead antes de asumir el buscador de Gestión de Tiempo', () => {
  assert.match(multiselect, /function cleanSearchInput/);
  assert.match(multiselect, /input\.cloneNode\(true\)/);
  assert.match(multiselect, /delete clean\.dataset\.lorrenLiveSearch/);
});
