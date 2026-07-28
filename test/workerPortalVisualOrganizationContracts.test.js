import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/public/worker-portal-offline.js', import.meta.url), 'utf8');

test('el portal reorganiza las asignaciones sin modificar el flujo de marcación', () => {
  assert.match(source, /function initializePortalPresentation\(\)/);
  assert.match(source, /querySelector\('\.assignment-list'\)/);
  assert.match(source, /enhanceAssignmentCard\(card, index\)/);
  assert.match(source, /portal-card-toggle/);
  assert.match(source, /aria-expanded/);
  assert.match(source, /data-mark-type="DEPARTURE"/);
  assert.match(source, /window\.LorrenWorkerPortalOffline = Object\.freeze/);
});

test('las asignaciones se agrupan visualmente por su fecha', () => {
  assert.match(source, /function parseAssignmentDate\(label\)/);
  assert.match(source, /function groupAssignments\(items, sourceList\)/);
  assert.match(source, /portal-date-groups/);
  assert.match(source, /portal-date-group/);
  assert.match(source, /Asignaciones agrupadas por fecha/);
  assert.match(source, /data-portal-group-count/);
});

test('el portal incluye rango de fechas, estado y periodos rápidos', () => {
  assert.match(source, /assignment-date-from/);
  assert.match(source, /assignment-date-to/);
  assert.match(source, /assignment-status-filter/);
  assert.match(source, /\['today', 'Hoy'\]/);
  assert.match(source, /\['upcoming', 'Próximas'\]/);
  assert.match(source, /\['week', '7 días'\]/);
  assert.match(source, /\['all', 'Todas'\]/);
  assert.match(source, /function applyFilters\(\)/);
  assert.match(source, /setPreset\('upcoming'\)/);
});

test('una jornada en curso permanece visible en el filtro de próximas', () => {
  assert.match(source, /keepActiveJourney = activePreset === 'upcoming' && item\.status === 'IN_PROGRESS'/);
  assert.match(source, /item\.status === 'IN_PROGRESS'/);
  assert.match(source, /Jornada en curso/);
});

test('la presentación usa nodos seguros y no interpola HTML de las asignaciones', () => {
  assert.match(source, /element\.textContent = text/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
});
