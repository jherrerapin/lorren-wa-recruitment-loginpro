import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildGlobalCandidateExportWhere,
  globalCandidateExportFilename,
  loadGlobalCandidateExportRows,
  resolveGlobalCandidateExportScopes
} from '../src/routes/adminCandidateGlobalExport.js';
import { CANDIDATE_EXPORT_SCOPES } from '../src/services/candidateExport.js';
import {
  candidateMatchesApplicantDateRange,
  normalizeApplicantDateRange
} from '../src/services/vacancyDashboardSearchExpansion.js';

function completeCandidate(overrides = {}) {
  return {
    id: overrides.id || 'candidate-test',
    fullName: 'Persona Ejemplo',
    phone: '573000000000',
    documentType: 'CC',
    documentNumber: '1000000000',
    age: 30,
    neighborhood: 'Zona Ejemplo',
    locality: null,
    zone: null,
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Público',
    status: 'REGISTRADO',
    createdAt: new Date('2026-09-08T15:00:00.000Z'),
    cvMimeType: 'application/pdf',
    cvOriginalName: 'cv-ejemplo.pdf',
    cvStorageKey: 'test/cv-ejemplo.pdf',
    vacancy: {
      id: 'vacancy-example',
      title: 'Vacante Ejemplo',
      role: 'Auxiliar',
      city: 'Bogotá'
    },
    ...overrides
  };
}

test('exportación global reutiliza acceso y rango Colombia en Candidate.createdAt', () => {
  const dateRange = normalizeApplicantDateRange({
    dateFrom: '2026-09-08',
    dateTo: '2026-09-09'
  });
  const where = buildGlobalCandidateExportWhere({
    isDev: false,
    scope: 'CITY',
    cities: ['Bogotá']
  }, dateRange);

  assert.deepEqual(where.vacancy, { city: { in: ['Bogotá'] } });
  assert.equal(where.createdAt.gte.toISOString(), '2026-09-08T05:00:00.000Z');
  assert.equal(where.createdAt.lte.toISOString(), '2026-09-10T04:59:59.999Z');
});

test('carga global delega los estados a filterCandidatesForExport sin solaparlos', async () => {
  const candidates = [
    completeCandidate({ id: 'registered-example', status: 'REGISTRADO' }),
    completeCandidate({ id: 'approved-example', status: 'APROBADO' }),
    completeCandidate({ id: 'contacted-example', status: 'CONTACTADO' }),
    completeCandidate({ id: 'contracted-example', status: 'CONTRATADO' }),
    completeCandidate({ id: 'rejected-example', status: 'RECHAZADO' })
  ];
  const observed = [];
  const prisma = {
    candidate: {
      findMany: async (args) => {
        observed.push(args);
        return candidates;
      }
    }
  };
  const accessContext = { isDev: false, scope: 'ALL' };
  const dateRange = normalizeApplicantDateRange({});

  const registered = await loadGlobalCandidateExportRows(prisma, {
    accessContext,
    scope: 'registered',
    dateRange
  });
  const approved = await loadGlobalCandidateExportRows(prisma, {
    accessContext,
    scope: 'approved',
    dateRange
  });
  const contracted = await loadGlobalCandidateExportRows(prisma, {
    accessContext,
    scope: 'contracted',
    dateRange
  });
  const rejected = await loadGlobalCandidateExportRows(prisma, {
    accessContext,
    scope: 'rejected',
    dateRange
  });

  assert.deepEqual(registered.map((candidate) => candidate.id), ['registered-example']);
  assert.deepEqual(approved.map((candidate) => candidate.id), ['approved-example']);
  assert.deepEqual(contracted.map((candidate) => candidate.id), ['contracted-example']);
  assert.deepEqual(rejected.map((candidate) => candidate.id), ['rejected-example']);
  assert.equal(observed.every((args) => args.orderBy?.createdAt === 'desc'), true);
});

test('la pestaña actual puede sumar Registrados, Completos sin HV y Contactados en el mismo Excel', async () => {
  const candidates = [
    completeCandidate({ id: 'registered-example', status: 'REGISTRADO' }),
    completeCandidate({
      id: 'missing-cv-example',
      status: 'REGISTRADO',
      cvMimeType: null,
      cvOriginalName: null,
      cvStorageKey: null
    }),
    completeCandidate({ id: 'contacted-example', status: 'CONTACTADO' }),
    completeCandidate({ id: 'approved-example', status: 'APROBADO' })
  ];
  const prisma = {
    candidate: {
      findMany: async () => candidates
    }
  };
  const scopes = resolveGlobalCandidateExportScopes({
    scope: 'approved',
    includeScopes: 'registered,missing_cv_complete,contacted'
  });

  assert.deepEqual(scopes, ['approved', 'registered', 'missing_cv_complete', 'contacted']);
  assert.deepEqual(resolveGlobalCandidateExportScopes({
    scope: 'missing_cv_complete',
    includeScopes: 'registered,contacted'
  }), ['missing_cv_complete', 'registered', 'contacted']);
  assert.deepEqual(resolveGlobalCandidateExportScopes({
    scope: 'contacted',
    includeScopes: 'registered,missing_cv_complete'
  }), ['contacted', 'registered', 'missing_cv_complete']);

  const exported = await loadGlobalCandidateExportRows(prisma, {
    accessContext: { isDev: false, scope: 'ALL' },
    scopes,
    dateRange: normalizeApplicantDateRange({
      dateFrom: '2026-09-08',
      dateTo: '2026-09-08'
    })
  });

  assert.deepEqual(exported.map((candidate) => candidate.id), [
    'registered-example',
    'missing-cv-example',
    'contacted-example',
    'approved-example'
  ]);
  assert.match(globalCandidateExportFilename(scopes), /^candidatos_aprobados_registrados_completos_sin_hv_contactados_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('Registrados, Completos sin HV y Contactados pueden agregarse desde cualquier scope principal válido', () => {
  const primaryScopes = [
    'registered',
    'missing_cv_complete',
    'approved',
    'contacted',
    'contracted',
    'rejected',
    'all'
  ];

  for (const primaryScope of primaryScopes) {
    const scopes = resolveGlobalCandidateExportScopes({
      scope: primaryScope,
      includeScopes: 'registered,missing_cv_complete,contacted'
    });
    const expected = Array.from(new Set([primaryScope, 'registered', 'missing_cv_complete', 'contacted']));
    assert.deepEqual(scopes, expected, primaryScope);
  }

  assert.deepEqual(resolveGlobalCandidateExportScopes({
    scope: 'approved',
    includeScopes: 'registered'
  }), ['approved', 'registered']);
  assert.equal(resolveGlobalCandidateExportScopes({
    scope: 'approved',
    includeScopes: 'rejected'
  }), null);
  assert.deepEqual(resolveGlobalCandidateExportScopes({ scope: 'approved' }), ['approved']);
});

test('la exportación global consume los scopes canónicos de candidatos', () => {
  for (const scope of [
    'registered',
    'missing_cv_complete',
    'approved',
    'contacted',
    'contracted',
    'rejected',
    'all'
  ]) {
    assert.equal(CANDIDATE_EXPORT_SCOPES.includes(scope), true, scope);
  }
});

test('la vista global reutiliza un solo selector visual y descarga la pestaña activa por /admin/export', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /\/admin\/export\?scope=/);
  assert.doesNotMatch(runtime, /link\.href = `\/admin\/export-global\?scope=/);
  assert.match(runtime, /GLOBAL_EXPORT_LABEL/);
  assert.match(runtime, /approvedOnly \? 'approved' : requestedStatus/);
  assert.match(runtime, /globalCandidateExportLink/);
  assert.match(runtime, /globalCandidateExportScope/);
  assert.match(runtime, /\.export-bar\[data-global-candidate-export="true"\]/);
  assert.match(runtime, /candidate-export-range-trigger/);
  assert.match(runtime, /Selecciona la fecha inicial y luego la fecha final/);
  assert.doesNotMatch(runtime, /input\.type\s*=\s*['"]date['"]/);
});

test('cada pestaña ofrece solo los otros scopes combinables y un único botón para el Excel', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /GLOBAL_OPTIONAL_EXPORT_SCOPES/);
  assert.match(runtime, /registered: 'Registrados'/);
  assert.match(runtime, /missing_cv_complete: 'Completos sin HV'/);
  assert.match(runtime, /contacted: 'Contactados'/);
  assert.match(runtime, /data-export-extra-scope/);
  assert.match(runtime, /function buildScopeOptions\(bar, panel\)/);
  assert.match(runtime, /function syncScopeOptionState\(wrapper, bar, panel\)/);
  assert.match(runtime, /const isActiveScope = String\(input\.value \|\| ''\) === activeScope/);
  assert.match(runtime, /label\.hidden = isActiveScope/);
  assert.match(runtime, /input\.disabled = isActiveScope/);
  assert.match(runtime, /input\.dataset\.explicitSelection = 'false'/);
  assert.match(runtime, /GLOBAL_OPTIONAL_EXPORT_SCOPES\.forEach/);
  assert.match(runtime, /const extraScopes = selectedExtraScopes\(bar, panel\)/);
  assert.match(runtime, /new URL\('\/admin\/export', window\.location\.origin\)/);
  assert.match(runtime, /url\.searchParams\.set\('includeScopes'/);
  assert.match(runtime, /actionRow\.append\(scopeOptions, downloadButton\)/);
  assert.match(runtime, /downloadButton\.textContent = '↓ Descargar'/);
  assert.match(runtime, /initialExportLinks\.forEach\(\(link\) => link\.remove\(\)\)/);
  assert.doesNotMatch(runtime, /link\.hidden = true/);
});

test('la descarga por vacante conserva vacancyId, rango y checks de la pestaña', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /panel\.getAttribute\('data-vacancy-panel'\)/);
  assert.match(runtime, /url\.searchParams\.set\('vacancyId', vacancyId\)/);
  assert.match(runtime, /function vacancyRangeTarget\(panel, dateFrom, dateTo\)/);
  assert.match(runtime, /syncIncludeScopesNavigation\(bar, panel\)/);
  assert.match(runtime, /panel\?\.addEventListener\('candidate-vacancy-tab-change'/);
  assert.match(runtime, /syncScopeOptionState\(scopeOptions, bar, panel\)/);
});

test('el rango y las selecciones opcionales se conservan al cambiar de pestaña', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /let selectedStart = validIsoDate\(initialParams\.get\('dateFrom'\)\)/);
  assert.match(runtime, /let selectedEnd = validIsoDate\(initialParams\.get\('dateTo'\)\)/);
  assert.match(runtime, /function syncGlobalRangeNavigation\(bar, dateFrom, dateTo\)/);
  assert.match(runtime, /function syncIncludeScopesNavigation\(bar, panel\)/);
  assert.match(runtime, /window\.history\.replaceState/);
  assert.match(runtime, /a\[href\^="\/admin\?"\]/);
  assert.match(runtime, /url\.searchParams\.has\('status'\)/);
  assert.match(runtime, /setRangeParam\(url, 'dateFrom', dateFrom\)/);
  assert.match(runtime, /setRangeParam\(url, 'dateTo', dateTo\)/);
  assert.match(runtime, /url\.searchParams\.set\('includeScopes', extraScopes\.join\(','\)\)/);
  assert.match(runtime, /form\[method="get"\]\[action="\/admin"\]/);
  assert.match(runtime, /setFormRangeInput\(form, 'dateFrom', dateFrom\)/);
  assert.match(runtime, /setFormRangeInput\(form, 'dateTo', dateTo\)/);
  assert.match(runtime, /syncGlobalRangeNavigation\(bar, selectedStart, selectedEnd\)/);
});

test('la descarga ya no deriva su destino de href heredados o indefinidos', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /new URL\('\/admin\/export', window\.location\.origin\)/);
  assert.match(runtime, /downloadButton\.href = `\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`/);
  assert.doesNotMatch(runtime, /rawBaseHref|rawHref|\/undefined/);
});

test('el listado global usa el mismo rango Colombia sobre Candidate.createdAt', () => {
  const dateRange = normalizeApplicantDateRange({
    dateFrom: '2026-09-08',
    dateTo: '2026-09-08'
  });

  assert.equal(candidateMatchesApplicantDateRange(
    completeCandidate({ createdAt: new Date('2026-09-08T15:00:00.000Z') }),
    dateRange
  ), true);
  assert.equal(candidateMatchesApplicantDateRange(
    completeCandidate({ createdAt: new Date('2026-09-09T15:00:00.000Z') }),
    dateRange
  ), false);
});

test('completar o quitar el rango global refresca el listado automáticamente sin botón aplicar', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /const globalRangeComplete = bar\.dataset\.globalCandidateExport === 'true'/);
  assert.match(runtime, /\(!selectedStart && !selectedEnd\) \|\| \(selectedStart && selectedEnd\)/);
  assert.match(runtime, /if \(globalRangeComplete\) window\.location\.reload\(\)/);
  assert.doesNotMatch(runtime, /Aplicar (?:filtro|rango)/i);
});

test('quitar el rango global elimina dateFrom/dateTo sin crear otro selector', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /else url\.searchParams\.delete\(key\)/);
  assert.match(runtime, /input\?\.remove\(\)/);
  assert.match(runtime, /selectedStart = '';/);
  assert.match(runtime, /selectedEnd = '';/);
  assert.equal((runtime.match(/className = 'candidate-export-date-range'/g) || []).length, 1);
});

test('server monta el transporte global antes del router admin principal', () => {
  const source = fs.readFileSync('src/server.js', 'utf8');
  const globalMount = source.indexOf("app.use('/admin', wrapAsyncRouter(adminCandidateGlobalExportRouter(prisma)))");
  const adminMount = source.indexOf("app.use('/admin', adminRouter(prisma))");

  assert.match(source, /import \{ adminCandidateGlobalExportRouter \} from '\.\/routes\/adminCandidateGlobalExport\.js';/);
  assert.notEqual(globalMount, -1);
  assert.notEqual(adminMount, -1);
  assert.equal(globalMount < adminMount, true);
});