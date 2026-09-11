import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  candidateHasCv,
  candidateExportCounts,
  deriveCandidateStatusForUI,
  exportFilenameByScope,
  filterCandidatesByScope,
  filterCandidatesForExport,
  formatDateForFilenameCO,
  isOperationallyCompleteWithoutCv,
  isOperationallyRegistered,
  normalizeCandidateStatusForUI
} from '../src/services/candidateExport.js';
import { getResidenceFieldConfig } from '../src/services/candidateData.js';

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

test('registered operativo exige completitud y conserva solo estados previos a decisión manual', () => {
  assert.equal(isOperationallyRegistered(baseCandidate), true);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, status: 'NUEVO' }), true);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, status: 'VALIDANDO' }), true);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, cvData: null }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, status: 'APROBADO' }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, status: 'CONTACTADO' }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, status: 'CONTRATADO' }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, status: 'RECHAZADO' }), false);
  assert.equal(isOperationallyRegistered({ ...baseCandidate, transportMode: '' }), false);
});

test('candidateHasCv reconoce hojas de vida migradas a almacenamiento externo', () => {
  assert.equal(candidateHasCv({ cvStorageKey: 'candidates/demo/cv/file.pdf' }), true);
  assert.equal(candidateHasCv({ cvStorageKey: null, cvData: null, cvOriginalName: null, cvMimeType: null }), false);
});

test('legacy VALIDANDO se normaliza a REGISTRADO y estados posteriores conservan su identidad', () => {
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

test('scopes de estado son exclusivos después de una decisión manual', () => {
  const candidates = [
    { ...baseCandidate, id: 'reg', status: 'REGISTRADO' },
    { ...baseCandidate, id: 'legacy-validando', status: 'VALIDANDO' },
    { ...baseCandidate, id: 'approved', status: 'APROBADO' },
    { ...baseCandidate, id: 'contacted', status: 'CONTACTADO' },
    { ...baseCandidate, id: 'contracted', status: 'CONTRATADO' },
    { ...baseCandidate, id: 'new-incomplete', status: 'NUEVO', cvData: null },
    { ...baseCandidate, id: 'rejected', status: 'RECHAZADO' }
  ];

  assert.deepEqual(filterCandidatesByScope(candidates, 'registered').map((c) => c.id), ['reg', 'legacy-validando']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'approved').map((c) => c.id), ['approved']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'contacted').map((c) => c.id), ['contacted']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'contracted').map((c) => c.id), ['contracted']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'rejected').map((c) => c.id), ['rejected']);
  assert.deepEqual(filterCandidatesByScope(candidates, 'new').map((c) => c.id), ['new-incomplete']);
});

test('scope all excluye rechazados y el apartado rejected conserva esos registros', () => {
  const candidates = [
    { ...baseCandidate, id: 'active-registered', status: 'REGISTRADO' },
    { ...baseCandidate, id: 'active-approved', status: 'APROBADO' },
    { ...baseCandidate, id: 'rejected-history', status: 'RECHAZADO' }
  ];

  assert.deepEqual(
    filterCandidatesByScope(candidates, 'all').map((candidate) => candidate.id),
    ['active-registered', 'active-approved']
  );
  assert.deepEqual(
    filterCandidatesByScope(candidates, 'rejected').map((candidate) => candidate.id),
    ['rejected-history']
  );
  assert.equal(candidates.length, 3, 'el filtrado no elimina ni muta el registro rechazado');
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

test('pendientes HV tampoco absorbe estados manuales posteriores', () => {
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, status: 'APROBADO' }), false);
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, status: 'CONTACTADO' }), false);
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, status: 'CONTRATADO' }), false);
  assert.equal(isOperationallyCompleteWithoutCv({ ...baseCandidate, cvData: null, status: 'RECHAZADO' }), false);
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

test('scope missing_cv_complete filtra candidatos completos sin HV aún no movidos a otro estado', () => {
  const candidates = [
    { ...baseCandidate, id: 'ok', cvData: null, status: 'REGISTRADO' },
    { ...baseCandidate, id: 'ok-contacted', cvData: null, status: 'CONTACTADO' },
    { ...baseCandidate, id: 'has-cv', cvData: Buffer.from('cv') },
    { ...baseCandidate, id: 'rejected', cvData: null, status: 'RECHAZADO' },
    { ...baseCandidate, id: 'missing-data', cvData: null, neighborhood: '' }
  ];

  assert.deepEqual(
    filterCandidatesByScope(candidates, 'missing_cv_complete').map((c) => c.id),
    ['ok']
  );
});

test('exportación no DEV excluye nuevos incompletos pero conserva completos con o sin HV', () => {
  const vacancy = { city: 'TEST Ciudad' };
  const completeWithCv = { ...baseCandidate, id: 'TEST-COMPLETE-CV', status: 'NUEVO', vacancy };
  const completeWithoutCv = { ...baseCandidate, id: 'TEST-COMPLETE-NO-CV', status: 'NUEVO', cvData: null, vacancy };
  const incompleteNew = { id: 'TEST-INCOMPLETE-NEW', status: 'NUEVO', fullName: null, vacancy };

  assert.deepEqual(
    filterCandidatesForExport([incompleteNew, completeWithCv, completeWithoutCv], 'all', { isDev: false, vacancy }).map((candidate) => candidate.id),
    ['TEST-COMPLETE-CV', 'TEST-COMPLETE-NO-CV']
  );
  assert.deepEqual(
    filterCandidatesForExport([incompleteNew, completeWithCv], 'all', { isDev: true, vacancy }).map((candidate) => candidate.id),
    ['TEST-INCOMPLETE-NEW', 'TEST-COMPLETE-CV']
  );
});

test('exportación no DEV no filtra solo por estado: aprobado o contratado incompleto tampoco se expone', () => {
  const vacancy = { city: 'TEST Ciudad' };
  const approvedIncomplete = { id: 'TEST-APPROVED-INCOMPLETE', status: 'APROBADO', fullName: 'TEST', vacancy };
  const contractedIncomplete = { id: 'TEST-CONTRACTED-INCOMPLETE', status: 'CONTRATADO', fullName: 'TEST', vacancy };
  const approvedComplete = { ...baseCandidate, id: 'TEST-APPROVED-COMPLETE', status: 'APROBADO', vacancy };
  const contractedComplete = { ...baseCandidate, id: 'TEST-CONTRACTED-COMPLETE', status: 'CONTRATADO', vacancy };

  assert.deepEqual(filterCandidatesForExport([approvedIncomplete, approvedComplete], 'approved', { vacancy }).map((candidate) => candidate.id), ['TEST-APPROVED-COMPLETE']);
  assert.deepEqual(filterCandidatesForExport([contractedIncomplete, contractedComplete], 'contracted', { vacancy }).map((candidate) => candidate.id), ['TEST-CONTRACTED-COMPLETE']);
});

test('conteos de exportación mantienen estados mutuamente exclusivos', () => {
  const vacancy = { city: 'TEST Ciudad' };
  const candidates = [
    { ...baseCandidate, id: 'TEST-REGISTERED', status: 'REGISTRADO', vacancy },
    { ...baseCandidate, id: 'TEST-MISSING-CV', status: 'REGISTRADO', cvData: null, vacancy },
    { ...baseCandidate, id: 'TEST-APPROVED', status: 'APROBADO', vacancy },
    { ...baseCandidate, id: 'TEST-CONTRACTED', status: 'CONTRATADO', vacancy },
    { id: 'TEST-NEW-INCOMPLETE', status: 'NUEVO', vacancy }
  ];

  assert.deepEqual(candidateExportCounts(candidates, { isDev: false, vacancy }), {
    registered: 1,
    missingCvComplete: 1,
    approved: 1,
    contracted: 1,
    all: 4
  });
});

test('ruta y vista consumen la autoridad canónica de exportación y ocultan descargas vacías', () => {
  const adminRouteSource = fs.readFileSync('src/routes/admin.js', 'utf8');
  const listSource = fs.readFileSync('src/views/list.ejs', 'utf8');
  assert.match(adminRouteSource, /filterCandidatesForExport\([\s\S]*\{ isDev: accessContext\.isDev, vacancy \}/);
  assert.match(adminRouteSource, /candidateExportCounts\(candidatesWithFlags, \{ isDev, vacancy: v \}\)/);
  assert.match(listSource, /v\.exportCounts\?\.approved/);
  assert.match(listSource, /v\.exportCounts\?\.contracted/);
  assert.match(listSource, /Descargar contratados/);
});

test('Excel por vacante pone fecha de registro primero y no exporta estado', () => {
  const adminRouteSource = fs.readFileSync('src/routes/admin.js', 'utf8');
  const exportStart = adminRouteSource.indexOf("router.get('/export'");
  const exportEnd = adminRouteSource.indexOf("router.get('/outreach/approved'", exportStart);
  const exportSource = adminRouteSource.slice(exportStart, exportEnd);
  const columnsStart = exportSource.indexOf('sheet.columns = [');
  const columnsEnd = exportSource.indexOf('];', columnsStart);
  assert.notEqual(columnsStart, -1, 'debe existir la definición de columnas del Excel');
  assert.notEqual(columnsEnd, -1, 'debe cerrar la definición de columnas del Excel');
  const columnsSource = exportSource.slice(columnsStart, columnsEnd);
  const headers = [...columnsSource.matchAll(/header: '([^']+)'/g)].map((match) => match[1]);
  assert.equal(headers[0], 'Fecha registro');
  assert.equal(headers.includes('Estado'), false);
  assert.doesNotMatch(exportSource, /const statusColors =/);
  assert.doesNotMatch(exportSource, /row\.getCell\('status'\)/);
});

test('Excel por vacante unifica teléfono/WhatsApp y usa una sola residencia según ciudad', () => {
  const adminRouteSource = fs.readFileSync('src/routes/admin.js', 'utf8');
  const exportStart = adminRouteSource.indexOf("router.get('/export'");
  const exportEnd = adminRouteSource.indexOf("router.get('/outreach/approved'", exportStart);
  const exportSource = adminRouteSource.slice(exportStart, exportEnd);
  const columnsStart = exportSource.indexOf('sheet.columns = [');
  const columnsEnd = exportSource.indexOf('];', columnsStart);
  const columnsSource = exportSource.slice(columnsStart, columnsEnd);
  const staticHeaders = [...columnsSource.matchAll(/header: '([^']+)'/g)].map((match) => match[1]);

  assert.equal(staticHeaders[0], 'Fecha registro');
  assert.equal(staticHeaders.filter((header) => header === 'Teléfono').length, 1);
  assert.equal(staticHeaders.includes('WhatsApp'), false);
  assert.equal(staticHeaders.includes('Estado'), false);
  assert.equal(staticHeaders.includes('Barrio'), false);
  assert.equal(staticHeaders.includes('Localidad'), false);
  assert.match(columnsSource, /header: residenceConfig\.labelTitle, key: residenceConfig\.field/);
  assert.match(exportSource, /const residenceConfig = getResidenceFieldConfig\(vacancy\);/);
  assert.match(exportSource, /\[residenceConfig\.field\]: residenceValue/);
  assert.match(exportSource, /row\.getCell\('phone'\)\.value = \{ text: normalizedCandidate\.phone, hyperlink: whatsappLink \}/);
  assert.doesNotMatch(exportSource, /row\.getCell\('whatsappLink'\)/);

  assert.deepEqual(getResidenceFieldConfig({ city: 'Bogotá' }), {
    field: 'locality', label: 'localidad', labelTitle: 'Localidad', articleLabel: 'la localidad'
  });
  assert.deepEqual(getResidenceFieldConfig({ city: 'Ibagué' }), {
    field: 'neighborhood', label: 'barrio', labelTitle: 'Barrio', articleLabel: 'el barrio'
  });
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
