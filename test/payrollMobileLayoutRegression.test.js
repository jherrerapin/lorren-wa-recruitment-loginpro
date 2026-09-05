import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Gestión de Tiempo conserva métricas por auxiliar sin resumen global ni columna Estado', async () => {
  const [view, detail] = await Promise.all([
    readFile(new URL('../src/views/operacionesGestionTiempo.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/partials/operacionesGestionTiempoTabla.ejs', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(view, /<section class="metrics">/);
  assert.doesNotMatch(view, /report\.totals\.workedDays|report\.totals\.deductedDays|report\.totals\.netWorkedDays/);

  assert.doesNotMatch(detail, /<th>Estado<\/th>/);
  assert.doesNotMatch(detail, /row\.status==='CON_NOVEDADES'/);
  assert.match(detail, /<th>Días remunerados<\/th>/);
  assert.match(detail, /<th>Días no remunerados<\/th>/);
  assert.match(detail, /<th>Permisos remunerados<\/th>/);
  assert.match(detail, /<th>Incapacidades<\/th>/);
  assert.match(detail, /<th>Turnos nocturnos<\/th>/);
  assert.match(detail, /<th>Domingos<\/th>/);
  assert.match(detail, /<th>Festivos<\/th>/);
  assert.doesNotMatch(detail, /<th>Días netos<\/th>/);
  assert.match(detail, /<th>Total<\/th>/);
  assert.match(detail, /<th>Ordinarias<\/th>/);
  assert.match(detail, /<th>Extra<\/th>/);
  assert.match(detail, /row\.remuneratedDays/);
  assert.match(detail, /row\.unremuneratedDays/);
  assert.match(detail, /row\.paidPermissionDays/);
  assert.match(detail, /row\.incapacityDays/);
  assert.match(detail, /row\.nightShiftCount/);
  assert.match(detail, /row\.sundayCount/);
  assert.match(detail, /row\.holidayCount/);
  assert.doesNotMatch(detail, /row\.netWorkedDays/);
  assert.match(detail, /COMPENSATORIO:'Compensatorio'/);
  assert.match(detail, /Domingo que generó el compensatorio:/);
  assert.match(detail, /Observación de coordinación:/);
  assert.match(detail, /correction\.reason/);
});

test('la tabla queda contenida en su panel y no expande el viewport móvil', async () => {
  const css = await readFile(new URL('../src/public/operaciones-gestion-tiempo.css', import.meta.url), 'utf8');

  assert.match(css, /\.page>\*\{min-width:0;max-width:100%\}/);
  assert.match(css, /\.panel\{[^}]*min-width:0;max-width:100%\}/);
  assert.match(css, /\.payroll-results-panel\{[^}]*min-width:0;max-width:100%;overflow:hidden\}/);
  assert.match(css, /\.table-wrap\{[^}]*overflow-x:auto;overflow-y:hidden;max-width:100%;min-width:0;width:100%/);
  assert.match(css, /-webkit-overflow-scrolling:touch/);
  assert.match(css, /th:first-child,td:first-child\{text-align:left\}/);
  assert.doesNotMatch(css, /th:nth-child\(2\),td:nth-child\(2\)\{text-align:left\}/);
});

test('la tabla de Gestión de Tiempo compacta columnas iniciales y muestra Ver más', async () => {
  const css = await readFile(new URL('../src/public/operaciones-gestion-tiempo.css', import.meta.url), 'utf8');

  assert.match(css, /\.payroll-results-panel th:first-child,\.payroll-results-panel td:first-child\{width:240px;min-width:240px;max-width:240px;white-space:normal\}/);
  assert.match(css, /\.payroll-results-panel th:nth-child\(2\),\.payroll-results-panel td:nth-child\(2\)\{width:76px;min-width:76px;max-width:76px/);
  assert.match(css, /\.payroll-results-panel th:nth-child\(3\),\.payroll-results-panel td:nth-child\(3\)\{width:84px;min-width:84px;max-width:84px/);
  assert.match(css, /\.payroll-results-panel th:nth-child\(4\),\.payroll-results-panel td:nth-child\(4\)\{width:64px;min-width:64px;max-width:64px/);
  assert.match(css, /\.payroll-results-panel th:last-child::before\{content:'Ver más'/);
  assert.match(css, /\.payroll-results-panel td:last-child summary::before\{content:'Ver más'/);
  assert.match(css, /\.payroll-results-panel td:last-child summary::marker\{font-size:11px/);
});

test('el panel conserva ancho completo sin estirar los filtros en escritorio', async () => {
  const view = await readFile(new URL('../src/views/operacionesGestionTiempo.ejs', import.meta.url), 'utf8');

  assert.match(view, /\.payroll-filter-panel\{width:100%;max-width:none\}/);
  assert.match(view, /\.payroll-filter-stack\{display:grid;grid-template-columns:repeat\(3,minmax\(220px,320px\)\);justify-content:start;gap:10px\}/);
  assert.match(view, /\.payroll-filter-row\{display:contents\}/);
  assert.match(view, /@media\(max-width:1050px\)\{\.payroll-filter-stack\{grid-template-columns:repeat\(2,minmax\(220px,320px\)\)\}\}/);
  assert.match(view, /@media\(max-width:760px\)\{\.payroll-filter-stack\{grid-template-columns:minmax\(0,1fr\);justify-content:stretch\}/);
  assert.match(view, /\.payroll-filter-actions\{display:flex;justify-content:flex-start;grid-column:1\/-1\}/);
  assert.doesNotMatch(view, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});

test('Auxiliares no hereda el margen superior global de details', async () => {
  const view = await readFile(new URL('../src/views/operacionesGestionTiempo.ejs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/public/operaciones-gestion-tiempo.css', import.meta.url), 'utf8');

  assert.match(css, /details\{margin-top:6px\}/);
  assert.match(view, /\.worker-picker\{position:relative;margin-top:0\}/);
});

test('el preview no presenta jornadas ya persistidas como filas duplicadas del Excel', async () => {
  const view = await readFile(new URL('../src/views/operacionesGestionTiempo.ejs', import.meta.url), 'utf8');

  assert.match(view, /metric\('Ya registradas',values\.duplicates\|\|0\)/);
  assert.doesNotMatch(view, /metric\('Duplicadas',values\.duplicates\|\|0\)/);
  assert.match(view, /DUPLICATE:'Ya registrada'/);
  assert.match(view, /Las jornadas ya registradas y los casos sin conciliar no se tocarán\./);
});
