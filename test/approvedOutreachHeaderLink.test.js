import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceApprovedRecruitmentUx } from '../src/services/approvedRecruitmentUx.js';

function approvedClientScriptBody(html = '') {
  const match = String(html).match(/<script\s+data-approved-recruitment-ux>([\s\S]*?)<\/script>/i);
  return match?.[1] || '';
}

test('Mensajes a aprobados reutiliza el enlace existente y lo mueve al encabezado de la vacante', () => {
  const html = [
    '<html><body>',
    '<section class="vacancy-panel" data-vacancy-panel="vacancy-example-1">',
    '<div class="vacancy-header"><div class="vacancy-badges"></div></div>',
    '<div class="vacancy-role">Auxiliar — Ciudad de ejemplo</div>',
    '<div class="export-bar"><a href="/admin/outreach/approved" class="export-btn">Mensajes a aprobados</a></div>',
    '</section>',
    '</body></html>'
  ].join('');

  const script = approvedClientScriptBody(enhanceApprovedRecruitmentUx(html));

  assert.match(script, /url\.searchParams\.set\('vacancyId', vacancyId\)/);
  assert.match(script, /const headerTarget = panel\.querySelector\('\.vacancy-badges'\) \|\| vacancyHeader/);
  assert.match(script, /outreachLink\.dataset\.approvedOutreachHeaderLink = vacancyId/);
  assert.match(script, /headerTarget\.appendChild\(outreachLink\)/);
  assert.match(script, /if \(!outreachLink\) return/);
  assert.doesNotMatch(script, /outreachLink\.cloneNode/);
});
