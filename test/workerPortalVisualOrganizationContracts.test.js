import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/public/worker-biometric.js', import.meta.url), 'utf8');
const view = fs.readFileSync(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');

function loadShouldPinActiveJourney() {
  const match = source.match(/function shouldPinActiveJourney\(status\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, 'worker-biometric.js debe conservar la autoridad de jornada fijada');
  return new Function('status', match[1]);
}

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
  assert.match(source, /setPreset\('today'\)/);
  assert.match(source, /setPreset\('all'\)/);
  assert.doesNotMatch(source, /\['today', 'Hoy'\]|\['upcoming', 'Próximas'\]|\['week', '7 días'\]|\['all', 'Todas'\]/);
});

test('una jornada en curso queda fijada aunque cambie la fecha operativa', () => {
  const shouldPinActiveJourney = loadShouldPinActiveJourney();
  assert.equal(shouldPinActiveJourney('IN_PROGRESS'), true);
  assert.equal(shouldPinActiveJourney('PENDING'), false);
  assert.equal(shouldPinActiveJourney('COMPLETED'), false);
  assert.match(source, /const keepActiveJourney = shouldPinActiveJourney\(item\.status\)/);
  assert.match(source, /const visible = \(keepActiveJourney \|\| \(matchesFrom && matchesTo\)\) && matchesStatus/);
  assert.doesNotMatch(source, /activePreset === 'upcoming' && item\.status === 'IN_PROGRESS'/);
});

test('la presentación usa nodos seguros y no interpola HTML', () => {
  assert.match(source, /element\.textContent = text/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
});