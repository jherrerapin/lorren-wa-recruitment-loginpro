import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/public/worker-biometric.js', import.meta.url), 'utf8');
const view = fs.readFileSync(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');

test('el portal organiza las asignaciones sin modificar los botones de marcación', () => {
  assert.match(source, /querySelector\('\.assignment-list'\)/);
  assert.match(source, /const cards = Array\.from/);
  assert.match(source, /assignmentStatus\(card\)/);
  assert.match(source, /data-mark-type="DEPARTURE"/);
  assert.match(source, /querySelector\('\.portal-filter-summary'\)/);
});

test('las asignaciones se agrupan visualmente por fecha', () => {
  assert.match(source, /function parseAssignmentDate\(label\)/);
  assert.match(source, /const groups = new Map\(\)/);
  assert.match(source, /portal-date-groups/);
  assert.match(source, /portal-date-group/);
  assert.match(source, /Asignaciones agrupadas por fecha/);
  assert.match(source, /data-portal-group-count/);
});

test('la vista define una sola vez el rango, estado y periodos rápidos', () => {
  assert.match(view, /id="assignment-date-from"/);
  assert.match(view, /id="assignment-date-to"/);
  assert.match(view, /id="assignment-status-filter"/);
  assert.match(view, /data-portal-preset="today"[^>]*>Hoy</);
  assert.match(view, /data-portal-preset="upcoming"[^>]*>Próximas</);
  assert.match(view, /data-portal-preset="week"[^>]*>7 días</);
  assert.match(view, /data-portal-preset="all"[^>]*>Todas</);
  assert.match(source, /function applyFilters\(\)/);
  assert.match(source, /setPreset\('all'\)/);
  assert.doesNotMatch(source, /\['today', 'Hoy'\]|\['upcoming', 'Próximas'\]|\['week', '7 días'\]|\['all', 'Todas'\]/);
});

test('una jornada en curso permanece visible en próximas', () => {
  assert.match(source, /keepActiveJourney = activePreset === 'upcoming' && item\.status === 'IN_PROGRESS'/);
  assert.match(source, /item\.status === 'IN_PROGRESS'/);
});

test('la presentación usa nodos seguros y no interpola HTML', () => {
  assert.match(source, /element\.textContent = text/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
});
