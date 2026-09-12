import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('recruitment dashboard renders vacancy tabs inside active city', () => {
  const view = fs.readFileSync('src/views/list.ejs', 'utf8');

  assert.match(view, /activeCityData\.vacancies\.length > 1/);
  assert.match(view, /class="vacancy-tabs"/);
  assert.match(view, /data-vacancy-tab="<%= tabVacancy\.id %>"/);
  assert.match(view, /class="vacancy-card vacancy-panel"/);
  assert.match(view, /data-vacancy-panel="<%= v\.id %>"/);
  assert.match(view, /function activateVacancy/);
  assert.match(view, /window\.location\.hash\.startsWith\('#vacancy-'\)/);
});

test('la vista por vacante retira los filtros operativos de transporte y residencia de la UI activa', () => {
  const runtime = fs.readFileSync('src/public/lorren-live-search.js', 'utf8');
  const retiredFilterBlock = runtime.match(
    /function clearRetiredVacancyFilterParams[\s\S]*?function setVacancySearchOptions/
  )?.[0] || '';

  assert.match(retiredFilterBlock, /key\.startsWith\('vf_'\)/);
  assert.match(retiredFilterBlock, /window\.location\.replace/);
  assert.match(retiredFilterBlock, /input\[name\^="vf_"\], select\[name\^="vf_"\]/);
  assert.match(retiredFilterBlock, /function retireVacancyOperationalFilters/);
  assert.match(retiredFilterBlock, /form\.vacancy-filter-bar/);
  assert.match(retiredFilterBlock, /if \(!isSearchForm\) form\.remove\(\)/);
});

test('el buscador de vacante ofrece solo Nombre y Documento y usa coincidencias progresivas', () => {
  const runtime = fs.readFileSync('src/public/lorren-live-search.js', 'utf8');
  const optionsBlock = runtime.match(
    /function setVacancySearchOptions[\s\S]*?function vacancyCandidateLookupUrl/
  )?.[0] || '';
  const matchBlock = runtime.match(
    /function filterVacancyCandidateResults[\s\S]*?function vacancyLegacyResults/
  )?.[0] || '';

  assert.match(optionsBlock, /nameOption\.value = 'name'/);
  assert.match(optionsBlock, /nameOption\.textContent = 'Nombre'/);
  assert.match(optionsBlock, /documentOption\.value = 'document'/);
  assert.match(optionsBlock, /documentOption\.textContent = 'Documento'/);
  assert.doesNotMatch(optionsBlock, /phone|Celular/);

  assert.match(matchBlock, /field === 'document'/);
  assert.match(matchBlock, /digits\(query\)/);
  assert.match(matchBlock, /item\.documentDigits\.includes\(queryDigits\)/);
  assert.match(matchBlock, /fold\(query\)/);
  assert.match(matchBlock, /fold\(item\.label\)\.includes\(normalizedQuery\)/);
});

test('el typeahead conserva el nombre y no usa la fecha DEV como etiqueta de coincidencia', () => {
  const runtime = fs.readFileSync('src/public/lorren-live-search.js', 'utf8');
  const view = fs.readFileSync('src/views/list.ejs', 'utf8');
  const candidateResultBlock = runtime.match(
    /function candidateRowResult[\s\S]*?function installLegacyRecruitmentSearch/
  )?.[0] || '';

  assert.match(view, /<%= c\.fullName \|\| '—' %>[\s\S]*candidate-dev-meta">Fecha de registro:/);
  assert.match(candidateResultBlock, /const directNameText = \[\.\.\.\(cells\[1\]\?\.childNodes \|\| \[\]\)\]/);
  assert.match(candidateResultBlock, /node\.nodeType === 3/);
  assert.match(candidateResultBlock, /\|\| directNameText/);
  assert.doesNotMatch(candidateResultBlock, /cells\[1\]\?\.querySelector\('div,strong'\)/);
});

test('las coincidencias respetan vacante y rango de registro y abren la ficha del candidato', () => {
  const runtime = fs.readFileSync('src/public/lorren-live-search.js', 'utf8');
  const lookupBlock = runtime.match(
    /function vacancyCandidateLookupUrl[\s\S]*?function filterVacancyCandidateResults/
  )?.[0] || '';
  const installBlock = runtime.match(
    /function installVacancyRecruitmentSearches[\s\S]*?function workerCardResult/
  )?.[0] || '';

  assert.match(lookupBlock, /url\.searchParams\.set\('status', 'all'\)/);
  assert.match(lookupBlock, /url\.searchParams\.set\('vacancyId', vacancyId\)/);
  assert.match(lookupBlock, /current\.searchParams\.get\('dateFrom'\)/);
  assert.match(lookupBlock, /current\.searchParams\.get\('dateTo'\)/);
  assert.match(lookupBlock, /url\.searchParams\.set\('dateFrom', dateFrom\)/);
  assert.match(lookupBlock, /url\.searchParams\.set\('dateTo', dateTo\)/);

  assert.match(installBlock, /fetchDocument\(vacancyCandidateLookupUrl\(vacancyId\), signal\)/);
  assert.match(installBlock, /filterVacancyCandidateResults\(candidates, query, field\)/);
  assert.match(installBlock, /window\.location\.assign\(item\.href\)/);
  assert.match(installBlock, /event\.preventDefault\(\)/);
  assert.match(installBlock, /liveSearch\?\.search\(\)/);
  assert.match(installBlock, /input\.placeholder = 'Escribe nombre o documento'/);
});

test('la coincidencia del buscador usa solo la ficha y nunca la subruta open-whatsapp', () => {
  const runtime = fs.readFileSync('src/public/lorren-live-search.js', 'utf8');
  const view = fs.readFileSync('src/views/list.ejs', 'utf8');
  const candidateResultBlock = runtime.match(
    /function candidateRowResult[\s\S]*?function installLegacyRecruitmentSearch/
  )?.[0] || '';

  assert.match(view, /candidateWhatsappHref\(candidate\)[\s\S]*open-whatsapp/);
  assert.match(view, /candidateDetailHref\(candidate\)[\s\S]*\/admin\/candidates\//);
  assert.match(candidateResultBlock, /a\.link-detail\[href\^="\/admin\/candidates\/"\]/);
  assert.match(candidateResultBlock, /detailPath = new URL\(href, window\.location\.origin\)\.pathname/);
  assert.ok(candidateResultBlock.includes("if (!/^\\/admin\\/candidates\\/[^/]+\\/?$/.test(detailPath)) return null;"));
  assert.doesNotMatch(candidateResultBlock, /a\[href\*="\/candidates\/"\]/);
  assert.doesNotMatch(candidateResultBlock, /open-whatsapp/);
});

test('admin movement labels are stored and displayed without mojibake', () => {
  const route = fs.readFileSync('src/routes/admin.js', 'utf8');

  assert.match(route, /function repairMojibakeLabel\(value\)/);
  assert.match(route, /const fallback = repairMojibakeLabel\(event\.eventLabel\);/);
  assert.match(route, /eventLabel: 'Edición manual de estado'/);
  assert.match(route, /eventLabel: 'Actualizó observaciones dev'/);
  assert.match(route, /eventLabel: 'Actualizó género del candidato'/);
  assert.doesNotMatch(route, /EdiciÃ³n|ActualizÃ³|gÃ©nero|PausÃ³|ReanudÃ³|AsignÃ³|AbriÃ³/);
});