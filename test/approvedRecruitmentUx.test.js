import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enhanceApprovedRecruitmentUx } from '../src/services/approvedRecruitmentUx.js';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('inyecta filtro Aprobados en el listado legado sin duplicarlo', () => {
  const html = '<html><body><table id="legacy-candidates-table"></table></body></html>';
  const enhanced = enhanceApprovedRecruitmentUx(html);
  assert.match(enhanced, /data-approved-recruitment-ux/);
  assert.match(enhanced, /approvedOnly/);
  assert.match(enhanced, /approvedLink\.textContent = 'Aprobados'/);
  assert.match(enhanced, /badge-aprobado/);
  assert.equal(enhanceApprovedRecruitmentUx(enhanced), enhanced);
});

test('el enlace Mensajes a aprobados se contextualiza por vacante y sucursal', () => {
  const html = '<html><body><div data-vacancy-panel="vac-123"><div class="vacancy-role">Auxiliar — Medellín</div><a href="/admin/outreach/approved">Mensajes a aprobados</a></div></body></html>';
  const enhanced = enhanceApprovedRecruitmentUx(html);
  assert.match(enhanced, /panel\.dataset\.vacancyPanel/);
  assert.match(enhanced, /searchParams\.set\('city', city\)/);
  assert.match(enhanced, /searchParams\.set\('vacancyId', vacancyId\)/);
});

test('Outreach aprobado encadena Sucursal -> Vacante en el navegador', () => {
  const view = readSource('src/views/outreachApproved.ejs');
  assert.match(view, /<label for="city">Sucursal<\/label>/);
  assert.match(view, /const citySelect = document\.getElementById\('city'\)/);
  assert.match(view, /const vacancySelect = document\.getElementById\('vacancyId'\)/);
  assert.match(view, /option\.dataset\.city/);
  assert.match(view, /option\.hidden = !visible/);
  assert.match(view, /option\.disabled = !visible/);
  assert.match(view, /citySelect\.addEventListener\('change', syncVacanciesToCity\)/);
});

test('la mejora global se aplica a las respuestas HTML', () => {
  const source = readSource('src/registerGlobalFavicon.js');
  assert.match(source, /enhanceApprovedRecruitmentUx/);
  assert.match(source, /enhanceApprovedRecruitmentUx\(/);
});
