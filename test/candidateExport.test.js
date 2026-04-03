import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  exportFilenameByScope,
  filterCandidatesByScope,
  formatDateForFilenameCO,
  isOperationallyCompleteWithoutCv,
  isOperationallyRegistered,
  normalizeCandidateStatusForUI
} from '../src/services/candidateExport.js';

const baseCandidate = {
  id: 'cand-1',
  fullName: 'Ana Perez',
  documentType: 'CC',
  documentNumber: '123',
  age: 25,
  neighborhood: 'Picalena',
  experienceInfo: 'Sí',
  experienceTime: '6 meses',
  medicalRestrictions: 'Sin restricciones médicas',
  transportMode: 'Moto',
  status: 'REGISTRADO',
  cvData: Buffer.from('cv')
};

test('registered operativo exige campos completos + CV + no rechazado', () => {
  assert.equal(isOperationallyRegistered(baseCandidate), true);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, cvData: null }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, status: 'RECHAZADO' }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, status: 'CONTACTADO' }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, experienceTime: '' }), false);
});

test('legacy VALIDANDO/APROBADO se normalizan visualmente a REGISTRADO', () => {
  assert.equal(normalizeCandidateStatusForUI('VALIDANDO'), 'REGISTRADO');
  assert.equal(normalizeCandidateStatusForUI('APROBADO'), 'REGISTRADO');
  assert.equal(normalizeCandidateStatusForUI('CONTACTADO'), 'CONTACTADO');
});

test('scope registered incluye estados legacy cuando cumplen criterio operativo', () => {
  const candidates = [
    { ...baseCandidate, id: 'reg', status: 'REGISTRADO' },
    { ...baseCandidate, id: 'legacy-validando', status: 'VALIDANDO' },
    { ...baseCandidate, id: 'legacy-aprobado', status: 'APROBADO' },
    { ...baseCandidate, id: 'contacted', status: 'CONTACTADO' },
    { ...baseCandidate, id: 'new-incomplete', status: 'NUEVO', cvData: null },
    { ...baseCandidate, id: 'rejected', status: 'RECHAZADO' }
  ];

  assert.deepEqual(
    filterCandidatesByScope(candidates, 'registered').map((c) => c.id),
    ['reg', 'legacy-validando', 'legacy-aprobado']
  );
  assert.deepEqual(filterCandidatesByScope(candidates, 'new').map((c) => c.id), ['new-incomplete']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'contacted').map((c) => c.id), ['contacted']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'rejected').map((c) => c.id), ['rejected']);
});

test('nombre de archivo de exportación usa scopes operativos', () => {
  assert.match(exportFilenameByScope('contacted'), /^candidatos_contactados_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.match(exportFilenameByScope('missing_cv_complete'), /^candidatos_pendientes_hv_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.match(exportFilenameByScope('invalid-scope'), /^candidatos_todos_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('formatDateForFilenameCO usa fecha de Colombia aunque UTC esté en otro día', () => {
  const fixedDate = new Date('2026-04-03T02:30:00.000Z');
  assert.equal(formatDateForFilenameCO(fixedDate), '2026-04-02');
});

test('isOperationallyCompleteWithoutCv devuelve true cuando está completo y sin HV', () => {
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null }), true);
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: '' }), true);
});

test('isOperationallyCompleteWithoutCv devuelve false si falta un dato clave', () => {
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, fullName: '' }), false);
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, experienceTime: null }), false);
});

test('isOperationallyCompleteWithoutCv devuelve false si está rechazado', () => {
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, status: 'RECHAZADO' }), false);
});

test('isOperationallyCompleteWithoutCv permite CONTACTADO si cumple criterio y sin HV', () => {
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, status: 'CONTACTADO' }), true);
});

test('scope missing_cv_complete filtra candidatos completos sin HV', () => {
  const candidates = [
    { ...baseCandidate, id: 'ok', cvData: null, status: 'REGISTRADO' },
    { ...baseCandidate, id: 'ok-contacted', cvData: null, status: 'CONTACTADO' },
    { ...baseCandidate, id: 'has-cv', cvData: Buffer.from('cv') },
    { ...baseCandidate, id: 'rejected', cvData: null, status: 'RECHAZADO' },
    { ...baseCandidate, id: 'missing-data', cvData: null, neighborhood: '' }
  ];

  assert.deepEqual(
    filterCandidatesByScope(candidates, 'missing_cv_complete').map((c) => c.id),
    ['ok', 'ok-contacted']
  );
});

test('ruta /admin/export acepta missing_cv_complete como scope válido', () => {
  const adminRouteSource = fs.readFileSync('src/routes/admin.js', 'utf8');
  assert.match(adminRouteSource, /const EXPORT_SCOPES = new Set\(\['registered', 'missing_cv_complete', 'new', 'contacted', 'rejected', 'all'\]\)/);
  assert.match(adminRouteSource, /const scope = EXPORT_SCOPES\.has\(requestedScope\) \? requestedScope : 'all';/);
});

test('vistas principales reemplazan branding de texto y referencian favicon', () => {
  const templates = ['src/views/list.ejs', 'src/views/detail.ejs', 'src/views/monitor.ejs', 'src/views/login.ejs'];
  for (const templatePath of templates) {
    const view = fs.readFileSync(templatePath, 'utf8');
    assert.match(view, /favicon-loginpro\.svg/);
    assert.match(view, /logo-loginpro\.svg/);
  }

  const navViews = ['src/views/list.ejs', 'src/views/detail.ejs', 'src/views/monitor.ejs'];
  for (const templatePath of navViews) {
    const view = fs.readFileSync(templatePath, 'utf8');
    assert.doesNotMatch(view, />LoginPro<\/span>/);
    assert.doesNotMatch(view, /Descargar Excel/);
  }
});
