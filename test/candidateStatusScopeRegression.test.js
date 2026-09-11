import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enhanceApprovedRecruitmentUx,
  vacancyStatusFilterDefinitions
} from '../src/services/approvedRecruitmentUx.js';
import { filterCandidatesByScope } from '../src/services/candidateExport.js';

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

test('un NUEVO completo con HV se clasifica como Registrado y deja de aparecer en Nuevos', () => {
  const completeNew = {
    id: 'candidate-scope-test',
    status: 'NUEVO',
    fullName: 'Persona Prueba',
    documentType: 'CC',
    documentNumber: 'TEST-DOC-001',
    age: 28,
    neighborhood: 'Zona Prueba',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    cvData: Buffer.from('cv-test')
  };

  assert.deepEqual(filterCandidatesByScope([completeNew], 'registered').map((candidate) => candidate.id), ['candidate-scope-test']);
  assert.deepEqual(filterCandidatesByScope([completeNew], 'new'), []);
});
