import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enhanceApprovedRecruitmentUx,
  vacancyStatusFilterDefinitions
} from '../src/services/approvedRecruitmentUx.js';

test('Aprobados deja de depender del scope Registrados', () => {
  const approved = vacancyStatusFilterDefinitions('admin')
    .find((filter) => filter.scope === 'approved');

  assert.deepEqual(approved, {
    scope: 'approved',
    routeScope: 'all',
    label: 'Aprobados',
    approvedOnly: true
  });

  const html = [
    '<html><body>',
    '<a href="/admin?status=registered">Registrados</a>',
    '<table id="legacy-candidates-table"><tbody></tbody></table>',
    '</body></html>'
  ].join('');
  const enhanced = enhanceApprovedRecruitmentUx(html);

  assert.match(enhanced, /url\.searchParams\.set\('status', 'all'\)/);
  assert.match(enhanced, /url\.searchParams\.set\('approvedOnly', '1'\)/);
});
