import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  candidateHasCv,
  deriveCandidateStatusForUI,
  exportFilenameByScope,
  filterCandidatesByScope,
  formatDateForFilenameCO,
  isOperationallyCompleteCandidate,
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
  assert.equal(isOperationallyRegistered({ ...baseCandidate, transportMode: '' }), false);
});

test('candidateHasCv reconoce hojas de vida migradas a almacenamiento externo', () => {
  assert.equal(candidateHasCv({ cvStorageKey: 'candidates/demo/cv/file.pdf' }), true);
  assert.equal(candidateHasCv({ cvStorageKey: null, cvData: null, cvOriginalName: null, cvMimeType: null }), false);
});

test('legacy VALIDANDO se normaliza a REGISTRADO y APROBADO se mantiene visible', () => {
  assert.equal(normalizeCandidateStatusForUI('VALIDANDO'), 'REGISTRADO');
  assert.equal(normalizeCandidateStatusForUI('APROBADO'), 'APROBADO');
  assert.equal(normalizeCandidateStatusForUI('CONTACTADO'), 'CONTACTADO');
  assert.equal(normalizeCandidateStatusForUI('CONTRATADO'), 'CONTRATADO');
});

test('deriveCandidateStatusForUI refleja reglas operativas reales', () => {
  assert.equal(deriveCandidateStatusForUI({ ...baseCandidate, status: 'NUEVO' }), 'REGISTRADO');
  assert.equal(deriveCandidateStatusForUI({ ...baseCandidate, status: 'REGISTRADO', cvData: null }), 'NUEVO');
  assert.equal(deriveCandidateStatusForUI({ ...baseCandidate, status: 'APROBADO', cvData: null }), 'APROBADO');
  assert.equal(deriveCandidateStatusForUI({ ...baseCandidate, status: 'CONTACTADO', cvData: null }), 'CONTACTADO');
  assert.equal(deriveCandidateStatusForUI({ ...baseCandidate, status: 'CONTRATADO', cvData: null }), 'CONTRATADO');
});

test('perfil operativo completo no depende de tener HV', () => {
  assert.equal(isOperationallyCompleteCandidate(baseCandidate), true);
  assert.equal(isOperationallyCompleteCandidate({ ...baseCandidate, cvData: null }), true);
  assert.equal(isOperationallyCompleteCandidate({ ...baseCandidate, fullName: '' }), false);
  assert.equal(isOperationallyCompleteCandidate({ ...baseCandidate, documentNumber: null }), false);
  assert.equal(isOperationallyCompleteCandidate({ ...baseCandidate, transportMode: '' }), false);
});

test('scope registered incluye estados legacy cuando cumplen criterio operativo', () => {
  const candidates = [
    { ...baseCandidate, id: 'reg', status: 'REGISTRADO' },
    { ...baseCandidate, id: 'legacy-validando', status: 'VALIDANDO' },
    { ...baseCandidate, id: 'legacy-aprobado', status: 'APROBADO' },
    { ...baseCandidate, id: 'contacted', status: 'CONTACTADO' },
    { ...baseCandidate, id: 'new-complete-no-cv', status: 'NUEVO', cvData: null },
    { ...baseCandidate, id: 'new-chat-only', status: 'NUEVO', fullName: '', documentType: null, documentNumber: null, age: null, neighborhood: null, medicalRestrictions: null, transportMode: null, cvData: null },
    { ...baseCandidate, id: 'rejected', status: 'RECHAZADO' }
  ];

  assert.deepEqual(
    filterCandidatesByScope(candidates, 'registered').map((c) => c.id),
    ['reg', 'legacy-validando', 'legacy-aprobado']
  );
  assert.deepEqual(filterCandidatesByScope(candidates, 'new').map((c) => c.id), ['new-complete-no-cv']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'contacted').map((c) => c.id), ['contacted']);
  assert.deepEqual(filterCandidatesByScope([...candidates, { ...baseCandidate, id: 'contracted', status: 'CONTRATADO' }], 'contracted').map((c) => c.id), ['contracted']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'rejected').map((c) => c.id), ['rejected']);
});

test('scope all significa todos los perfiles exportables y excluye chats nuevos incompletos', () => {
  const candidates = [
    { ...baseCandidate, id: 'registered-with-cv', status: 'REGISTRADO' },
    { ...baseCandidate, id: 'registered-without-cv', status: 'NUEVO', cvData: null },
    { ...baseCandidate, id: 'approved-complete', status: 'APROBADO' },
    { ...baseCandidate, id: 'contracted-complete', status: 'CONTRATADO', cvData: null },
    { ...baseCandidate, id: 'new-chat-only', status: 'NUEVO', fullName: '', documentType: null, documentNumber: null, age: null, neighborhood: null, medicalRestrictions: null, transportMode: null, cvData: null },
    { ...baseCandidate, id: 'rejected-history', status: 'RECHAZADO' }
  ];

  assert.deepEqual(
    filterCandidatesByScope(candidates, 'all').map((candidate) => candidate.id),
    ['registered-with-cv', 'registered-without-cv', 'approved-complete', 'contracted-complete']
  );
  assert.deepEqual(
    filterCandidatesByScope(candidates, 'rejected').map((candidate) => candidate.id),
    ['rejected-history']
  );
  assert.equal(candidates.length, 6, 'el filtrado no elimina ni muta los registros fuente');
});

test('scopes aprobados y contratados tampoco exportan perfiles operativamente incompletos', () => {
  const candidates = [
    { ...baseCandidate, id: 'approved-ok', status: 'APROBADO' },
    { ...baseCandidate, id: 'approved-incomplete', status: 'APROBADO', documentNumber: null },
    { ...baseCandidate, id: 'contracted-ok', status: 'CONTRATADO', cvData: null },
    { ...baseCandidate, id: 'contracted-incomplete', status: 'CONTRATADO', fullName: '' }
  ];

  assert.deepEqual(filterCandidatesByScope(candidates, 'approved').map((candidate) => candidate.id), ['approved-ok']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'contracted').map((candidate) => candidate.id), ['contracted-ok']);
});

test('nombre de archivo de exportación usa scopes operativos', () => {
  assert.match(exportFilenameByScope('contacted'), /^candidatos_contactados_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.match(exportFilenameByScope('contracted'), /^candidatos_contratados_\d{4}-\d{2}-\d{2}\.xlsx$/);
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
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, transportMode: null }), false);
});

test('isOperationallyCompleteWithoutCv devuelve false si está rechazado', () => {
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, status: 'RECHAZADO' }), false);
});

test('isOperationallyCompleteWithoutCv permite CONTACTADO si cumple criterio y sin HV', () => {
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, status: 'CONTACTADO' }), true);
});

test('criterios operativos aceptan localidad en Bogota aunque no haya barrio', () => {
  const bogotaCandidate = {
    ...baseCandidate,
    neighborhood: null,
    locality: 'Suba',
    vacancy: { city: 'Bogota' }
  };

  assert.equal(isOperationallyRegistered(bogotaCandidate), true);
  assert.equal(isOperationallyCompleteWithoutCv({ ...bogotaCandidate, cvData: null }), true);
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
  assert.match(adminRouteSource, /const EXPORT_SCOPES = new Set\(\['registered', 'missing_cv_complete', 'approved', 'new', 'contacted', 'contracted', 'rejected', 'all'\]\)/);
  assert.match(adminRouteSource, /const scope = normalizeString\(req\.query\.scope\) \|\| 'all';/);
  assert.match(adminRouteSource, /if \(!EXPORT_SCOPES\.has\(scope\)\)/);
  assert.match(adminRouteSource, /res\.status\(400\)\.send\(/);
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
