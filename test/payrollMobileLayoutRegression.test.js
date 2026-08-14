import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Nómina conserva métricas por auxiliar sin resumen global ni columna Estado', async () => {
  const [view, detail] = await Promise.all([
    readFile(new URL('../src/views/operacionesNomina.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/partials/operacionesNominaTabla.ejs', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(view, /<section class="metrics">/);
  assert.doesNotMatch(view, /report\.totals\.workedDays|report\.totals\.deductedDays|report\.totals\.netWorkedDays/);

  assert.doesNotMatch(detail, /<th>Estado<\/th>/);
  assert.doesNotMatch(detail, /row\.status==='CON_NOVEDADES'/);
  assert.match(detail, /<th>Días trabajados<\/th>/);
  assert.match(detail, /<th>Días descontados<\/th>/);
  assert.match(detail, /<th>Días netos<\/th>/);
  assert.match(detail, /<th>Total<\/th>/);
  assert.match(detail, /<th>Ordinarias<\/th>/);
  assert.match(detail, /<th>Extra<\/th>/);
  assert.match(detail, /row\.workedDays/);
  assert.match(detail, /row\.deductedDays/);
  assert.match(detail, /row\.netWorkedDays/);
  assert.match(detail, /Observación de coordinación:/);
  assert.match(detail, /correction\.reason/);
});

test('la tabla queda contenida en su panel y no expande el viewport móvil', async () => {
  const css = await readFile(new URL('../src/public/operaciones-nomina.css', import.meta.url), 'utf8');

  assert.match(css, /\.page>\*\{min-width:0;max-width:100%\}/);
  assert.match(css, /\.panel\{[^}]*min-width:0;max-width:100%\}/);
  assert.match(css, /\.payroll-results-panel\{overflow:hidden\}/);
  assert.match(css, /\.table-wrap\{[^}]*overflow-x:auto;overflow-y:hidden;max-width:100%;min-width:0;width:100%/);
  assert.match(css, /-webkit-overflow-scrolling:touch/);
  assert.match(css, /th:first-child,td:first-child\{text-align:left\}/);
  assert.doesNotMatch(css, /th:nth-child\(2\),td:nth-child\(2\)\{text-align:left\}/);
});
