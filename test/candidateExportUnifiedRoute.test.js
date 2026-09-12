import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminCandidateGlobalExportRouter,
  buildGlobalCandidateExportWhere,
  resolveGlobalCandidateExportScopes
} from '../src/routes/adminCandidateGlobalExport.js';
import { normalizeApplicantDateRange } from '../src/services/vacancyDashboardSearchExpansion.js';

test('la descarga publica /export y conserva /export-global como compatibilidad', () => {
  const router = adminCandidateGlobalExportRouter({});
  const paths = router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]);

  assert.equal(paths.includes('/export'), true);
  assert.equal(paths.includes('/export-global'), true);
});

test('vacante solicitada se intersecta con alcance autorizado y rango Colombia', () => {
  const range = normalizeApplicantDateRange({
    dateFrom: '2026-09-01',
    dateTo: '2026-09-07'
  });
  const where = buildGlobalCandidateExportWhere({
    isDev: false,
    scope: 'VACANCY',
    vacancyIds: ['vacancy-allowed']
  }, range, 'vacancy-requested');

  assert.deepEqual(where.AND[0], { vacancyId: 'vacancy-allowed' });
  assert.deepEqual(where.AND[1], { vacancyId: 'vacancy-requested' });
  assert.equal(where.AND[2].createdAt.gte.toISOString(), '2026-09-01T05:00:00.000Z');
  assert.equal(where.AND[2].createdAt.lte.toISOString(), '2026-09-08T04:59:59.999Z');
});

test('pestaña activa puede sumar solamente Completos sin HV y Contactados sin duplicar scopes', () => {
  assert.deepEqual(resolveGlobalCandidateExportScopes({
    scope: 'approved',
    includeScopes: 'missing_cv_complete,contacted'
  }), ['approved', 'missing_cv_complete', 'contacted']);

  assert.deepEqual(resolveGlobalCandidateExportScopes({
    scope: 'contacted',
    includeScopes: 'missing_cv_complete,contacted'
  }), ['contacted', 'missing_cv_complete']);

  assert.equal(resolveGlobalCandidateExportScopes({
    scope: 'approved',
    includeScopes: 'rejected'
  }), null);
});
