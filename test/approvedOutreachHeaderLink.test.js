import test from 'node:test';
import assert from 'node:assert/strict';
import { enhanceApprovedRecruitmentUx } from '../src/services/approvedRecruitmentUx.js';

function approvedClientScriptBody(html = '') {
  const match = String(html).match(/<script\s+data-approved-recruitment-ux>([\s\S]*?)<\/script>/i);
  return match?.[1] || '';
}

test('Mensajes a aprobados se retira del encabezado porque la citación es automática', () => {
  const html = [
    '<html><body>',
    '<section class="vacancy-panel" data-vacancy-panel="vacancy-example-1">',
    '<div class="vacancy-header"><div class="vacancy-badges"></div></div>',
    '<div class="vacancy-role">Auxiliar — Ciudad de ejemplo</div>',
    '<div class="export-bar"><a href="/admin/outreach/approved" class="export-btn">Mensajes a aprobados</a></div>',
    '</section>',
    '</body></html>'
  ].join('');

  const enhanced = enhanceApprovedRecruitmentUx(html);
  const script = approvedClientScriptBody(enhanced);

  assert.doesNotMatch(enhanced, /href=["']\/admin\/outreach\/approved["']/);
  assert.doesNotMatch(enhanced, />Mensajes a aprobados<\/a>/);
  assert.doesNotMatch(script, /approvedOutreachHeaderLink|headerTarget\.appendChild\(outreachLink\)|outreachLink\.cloneNode/);
  assert.match(script, /installVacancyStatusFilters\(panel, vacancyId\)/);
});
