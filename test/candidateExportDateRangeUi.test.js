import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';

const baseHtml = `<!doctype html>
<html>
<head><title>Admin</title></head>
<body>
  <nav class="navbar"><a href="/admin">Panel</a></nav>
  <main></main>
</body>
</html>`;

function req(role = 'admin', originalUrl = '/admin') {
  return {
    originalUrl,
    userRole: role,
    session: { userRole: role }
  };
}

test('el rango de exportación se carga en /admin para no DEV y no para DEV', () => {
  const adminHtml = injectAdminModuleNavigation(baseHtml, req('admin'));
  assert.match(adminHtml, /\/public\/candidate-export-date-range\.js/);
  assert.equal((adminHtml.match(/candidate-export-date-range\.js/g) || []).length, 1);

  const devHtml = injectAdminModuleNavigation(baseHtml, req('dev'));
  assert.doesNotMatch(devHtml, /candidate-export-date-range\.js/);

  const usersHtml = injectAdminModuleNavigation(baseHtml, req('admin', '/admin/users'));
  assert.doesNotMatch(usersHtml, /candidate-export-date-range\.js/);
});

test('el controlador conserva scope y vacancyId y solo añade el rango de registro', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /\/admin\/export\?/);
  assert.match(runtime, /new URL\(link\.getAttribute\('href'\), window\.location\.origin\)/);
  assert.match(runtime, /url\.searchParams\.set\('dateFrom', dateFrom\)/);
  assert.match(runtime, /url\.searchParams\.set\('dateTo', dateTo\)/);
  assert.match(runtime, /url\.searchParams\.delete\('dateFrom'\)/);
  assert.match(runtime, /url\.searchParams\.delete\('dateTo'\)/);
  assert.doesNotMatch(runtime, /searchParams\.set\('scope'/);
  assert.doesNotMatch(runtime, /searchParams\.set\('vacancyId'/);
});

test('el rango invertido usa aviso inline y no diálogos nativos', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /dateFrom && dateTo && dateFrom > dateTo/);
  assert.match(runtime, /candidate-export-date-error/);
  assert.match(runtime, /event\.preventDefault\(\)/);
  assert.doesNotMatch(runtime, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.match(runtime, /@media\(max-width:768px\)/);
});

test('la ruta de exportación mantiene la autoridad de fecha en Candidate.createdAt', () => {
  const adminRouteSource = fs.readFileSync('src/routes/admin.js', 'utf8');

  assert.match(adminRouteSource, /const dateFilter = normalizeCandidateDateRangeFilter\(req\.query\);/);
  assert.match(adminRouteSource, /dateFilter\.createdAtWhere/);
  assert.match(adminRouteSource, /createdAt:\s*dateFilter\.createdAtWhere/);
  assert.match(adminRouteSource, /filterCandidatesForExport\([\s\S]*\{ isDev: accessContext\.isDev, vacancy \}/);
});
