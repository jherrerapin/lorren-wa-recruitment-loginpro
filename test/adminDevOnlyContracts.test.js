import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dispatchAuditMiddleware } from '../src/services/dispatchAuditMiddleware.js';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('AppUser schema has dispatch access permission and migration', () => {
  const schema = readSource('prisma/schema.prisma');
  assert.match(schema, /canAccessDispatch\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /@@index\(\[canAccessDispatch\]\)/);

  const migrationsDir = new URL('../prisma/migrations', import.meta.url);
  const migrationFiles = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('_add_dispatch_access_to_app_user'))
    .map((entry) => readFileSync(join(migrationsDir.pathname, entry.name, 'migration.sql'), 'utf8'));

  assert.ok(migrationFiles.length > 0, 'Debe existir una migración para canAccessDispatch.');
  assert.ok(
    migrationFiles.some((source) => /ADD COLUMN "canAccessDispatch"/.test(source)),
    'La migración debe agregar la columna canAccessDispatch.'
  );
  assert.ok(
    migrationFiles.some((source) => /CREATE INDEX "AppUser_canAccessDispatch_idx"/.test(source)),
    'La migración debe crear el índice AppUser_canAccessDispatch_idx.'
  );
});

test('login session carries dispatch access permission', () => {
  const serverSource = readSource('src/server.js');

  assert.match(serverSource, /select:\s*{[\s\S]*?canAccessDispatch:\s*true[\s\S]*?isActive:\s*true[\s\S]*?}/);
  assert.match(serverSource, /function\s+buildUserSessionPayload\s*\([^)]*\)\s*{[\s\S]*?canAccessDispatch:\s*Boolean\(user\.canAccessDispatch\)/);
  assert.match(serverSource, /function\s+applySessionPayload\s*\([^)]*\)\s*{[\s\S]*?req\.session\.canAccessDispatch\s*=\s*Boolean\(payload\.canAccessDispatch\)/);
  assert.match(serverSource, /req\.canAccessDispatch\s*=\s*Boolean\(req\.session\?\.canAccessDispatch\)/);
  assert.match(serverSource, /canAccessDispatch:\s*role\s*===\s*['"]dev['"]/);
});

test('operations bridge allows DEV or canAccessDispatch and still protects session', () => {
  const bridgeSource = readSource('src/routes/dispatchBridge.js');

  assert.match(
    bridgeSource,
    /function\s+requireOps\s*\([^)]*\)\s*{[\s\S]*?!role[\s\S]*?redirect\(['"]\/login['"]\)[\s\S]*?!canUseOps\(req\)[\s\S]*?403/,
    'Operaciones debe redirigir a /login sin sesión y responder 403 sin permiso.'
  );
  assert.match(bridgeSource, /role\s*===\s*['"]dev['"][\s\S]*?canAccessDispatch/);
  assert.match(bridgeSource, /req\.session\?\.canAccessDispatch\s*\|\|\s*req\.canAccessDispatch/);
  assert.doesNotMatch(
    bridgeSource,
    /DISPATCH_MODULE_URL|dispatchModuleUrl|normalizeHttpUrl|res\.redirect\(dispatchModuleUrl\)/,
    'El router nativo no debe depender de DISPATCH_MODULE_URL ni redirigir a URLs externas.'
  );
});

test('operations bridge dashboard fallback renders required locals', () => {
  const bridgeSource = readSource('src/routes/dispatchBridge.js');

  assert.match(bridgeSource, /function\s+renderOperationsDashboard\s*\(\s*req\s*,\s*res\s*,\s*options\s*=\s*\{\}\s*\)/);
  assert.match(bridgeSource, /selectedDate:\s*todayIsoDate\(\)/);
  assert.match(bridgeSource, /metrics:\s*\{[\s\S]*?totalRequests:\s*0[\s\S]*?pendingRequests:\s*0[\s\S]*?completedRequests:\s*0[\s\S]*?openIncidents:\s*0[\s\S]*?\}/);
  assert.match(bridgeSource, /role:\s*req\.session\?\.userRole\s*\|\|\s*req\.userRole/);
  assert.match(bridgeSource, /router\.get\(\s*['"]\/novedades['"][\s\S]*?renderOperationsDashboard\(req,\s*res/);
});

test('legacy admin operations fallback renders dashboard required locals', () => {
  const adminSource = readSource('src/routes/admin.js');

  assert.match(adminSource, /router\.get\(\s*['"]\/operaciones['"][\s\S]*?res\.render\(\s*['"]operacionesDashboard['"]/);
  assert.match(adminSource, /router\.get\(\s*['"]\/operaciones['"][\s\S]*?selectedDate:\s*todayCO\(\)/);
  assert.match(adminSource, /router\.get\(\s*['"]\/operaciones['"][\s\S]*?metrics:\s*\{[\s\S]*?totalRequests:\s*0[\s\S]*?pendingRequests:\s*0[\s\S]*?completedRequests:\s*0[\s\S]*?openIncidents:\s*0[\s\S]*?\}/);
  assert.match(adminSource, /router\.get\(\s*['"]\/operaciones['"][\s\S]*?canAccessDispatch:\s*Boolean\(req\.canAccessDispatch\)/);
});

test('admin user creation restricts canAccessDispatch to DEV in backend', () => {
  const adminSource = readSource('src/routes/admin.js');

  assert.match(adminSource, /router\.post\(\s*['"]\/users\/create['"]/);
  assert.match(adminSource, /const\s+canAccessDispatch\s*=\s*req\.userRole\s*===\s*['"]dev['"]\s*&&\s*req\.body\.canAccessDispatch\s*===\s*['"]true['"]/);
  assert.match(adminSource, /prisma\.appUser\.create\([\s\S]*?data:\s*{[\s\S]*?username,[\s\S]*?role:\s*['"]ADMIN['"][\s\S]*?canAccessDispatch,/);
  assert.match(adminSource, /buildUniqueRecruiterUsername/);
});



test('operations dashboard uses updated LoginPro logo asset', () => {
  const operationsView = readSource('src/views/operacionesDashboard.ejs');

  assert.match(operationsView, /<img src=["']\/public\/logo-loginpro\.svg["'] alt=["']LoginPro["'] \/>/);
  assert.doesNotMatch(operationsView, /\/public\/loginpro\.png/);
});

test('users view has one form with dispatch checkbox and no operations-only form', () => {
  const usersView = readSource('src/views/users.ejs');

  assert.match(usersView, /name=["']canAccessDispatch["']/);
  assert.match(usersView, /id=["']canAccessDispatch["']/);
  assert.match(usersView, /value=["']true["']/);
  assert.match(usersView, />Operaciones \/ Despacho</);
  assert.match(usersView, /Permite entrar al panel operativo además del alcance de reclutamiento seleccionado\./);
  assert.match(usersView, /<%\s*if\s*\(role\s*===\s*['\"]dev['\"]\)\s*{\s*%>[\s\S]*id=["']canAccessDispatch["'][\s\S]*<%\s*}\s*%>/);
  assert.match(usersView, /if \(user\.canAccessDispatch\)[\s\S]*Operaciones \/ Despacho/);
  assert.doesNotMatch(usersView, /Crear usuario de Operaciones \/ Despacho/);
  assert.doesNotMatch(usersView, /\/admin\/users\/create-operations/);
});

test('los perfiles protegidos solo aparecen en el listado de usuarios para DEV', () => {
  const adminSource = readSource('src/routes/admin.js');
  const start = adminSource.indexOf('function buildManageableUsersWhere');
  const end = adminSource.indexOf('function isManualAttentionCandidate', start);
  const visibilityRule = adminSource.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(visibilityRule, /hiddenUsernames\s*=\s*\['reclutador-general',\s*environmentAdminUsername\(\)\]/);
  assert.match(visibilityRule, /accessContext\.isDev\s*\?\s*\{\}\s*:\s*\{\s*username:\s*\{\s*notIn:/);
  assert.match(visibilityRule, /return \{ role: 'ADMIN', \.\.\.visibilityWhere \}/);
});

test('reclutador-general puede administrar usuarios y el perfil de Railway queda protegido', () => {
  const adminSource = readSource('src/routes/admin.js');
  const locationsSource = readSource('src/routes/locations.js');
  const usersView = readSource('src/views/users.ejs');

  assert.match(adminSource, /source\s*===\s*'db'[\s\S]*?username\s*===\s*'reclutador-general'[\s\S]*?accessScope\s*===\s*'ALL'/);
  assert.match(adminSource, /if \(accessContext\.isDev\) \{\s*await ensureEnvironmentAdminProfile\(prisma\)/);
  assert.match(adminSource, /passwordHash:\s*await bcrypt\.hash\(randomUUID\(\),\s*12\)/);
  assert.match(locationsSource, /req\.userSource\s*===\s*'db'[\s\S]*?req\.username\s*===\s*'reclutador-general'[\s\S]*?req\.userAccessScope\s*===\s*'ALL'/);
  assert.match(locationsSource, /req\.userRole\s*!==\s*'dev'\s*&&\s*isProtectedRecruiterProfile\(user\)/);
  assert.match(usersView, /Perfil principal configurado en Railway/);
  assert.match(usersView, /user\.username\s*!==\s*environmentAdminUsername[\s\S]*?reset-password/);
});

test('la cuenta reclutador de Railway recibe los permisos editados sin cerrar sesión', async (t) => {
  const previousAdminUser = process.env.ADMIN_USER;
  process.env.ADMIN_USER = 'reclutador';
  t.after(() => {
    if (previousAdminUser === undefined) delete process.env.ADMIN_USER;
    else process.env.ADMIN_USER = previousAdminUser;
  });

  let requestedWhere = null;
  const prisma = {
    appUser: {
      findUnique: async ({ where }) => {
        requestedWhere = where;
        return {
          id: 'env-profile-1',
          isActive: true,
          accessScope: 'ALL',
          scopeCity: null,
          scopeVacancyId: null,
          canAccessDispatch: true,
          canAccessStatistics: true,
          canAccessMetaAds: false,
          canAccessCvAnalysis: true
        };
      }
    }
  };
  const req = {
    method: 'GET',
    path: '/admin',
    session: {
      userSource: 'env',
      userRole: 'admin',
      username: 'reclutador',
      userId: null
    }
  };

  await dispatchAuditMiddleware(prisma)(req, {}, () => {});

  assert.deepEqual(requestedWhere, { username: 'reclutador' });
  assert.equal(req.session.userId, 'env-profile-1');
  assert.equal(req.session.canAccessDispatch, true);
  assert.equal(req.session.canAccessMetaAds, false);
  assert.equal(req.session.canAccessCvAnalysis, true);
  assert.equal(req.session.canAccessStatistics, true);
});

test('operations-only creation routes were removed from server', () => {
  const serverSource = readSource('src/server.js');

  assert.doesNotMatch(serverSource, /app\.get\(\s*['"]\/admin\/users\/create-operations['"]/);
  assert.doesNotMatch(serverSource, /app\.post\(\s*['"]\/admin\/users\/create-operations['"]/);
  assert.doesNotMatch(serverSource, /buildUniqueOperationsUsername/);
});

test('operations navigation uses dispatch permission without target blank', () => {
  const views = [
    'src/views/list.ejs',
    'src/views/vacancies.ejs',
    'src/views/detail.ejs',
    'src/views/users.ejs',
    'src/views/locations.ejs',
    'src/views/outreachApproved.ejs',
    'src/views/monitor.ejs',
    'src/views/botKnowledge.ejs'
  ];

  for (const viewPath of views) {
    const viewSource = readSource(viewPath);
    const operationsIndex = viewSource.indexOf('/admin/operaciones');
    assert.notEqual(operationsIndex, -1, `${viewPath} debe enlazar Operaciones / Despacho.`);

    const directOperationsLink = viewSource.match(/<a[^>]+href=["']\/admin\/operaciones["'][^>]*>\s*Operaciones \/ Despacho/);
    assert.ok(directOperationsLink, `${viewPath} debe enlazar directamente a /admin/operaciones.`);
    assert.doesNotMatch(directOperationsLink[0], /target=["']_blank["']/);

    const beforeLink = viewSource.slice(Math.max(0, operationsIndex - 250), operationsIndex);
    assert.match(beforeLink, /role\s*===\s*['"]dev['"]\s*\|\|\s*canAccessDispatch/);
  }

  const allViewSource = views.map(readSource).join('\n');
  assert.doesNotMatch(allViewSource, /target=["']_blank["'][^>]*>\s*Operaciones \/ Despacho/);
});


test('monitor navigation remains dev-only outside operations dashboard', () => {
  const views = [
    'src/views/list.ejs',
    'src/views/vacancies.ejs',
    'src/views/detail.ejs',
    'src/views/users.ejs',
    'src/views/locations.ejs',
    'src/views/outreachApproved.ejs',
    'src/views/operacionesDashboard.ejs'
  ];

  for (const viewPath of views) {
    const viewSource = readSource(viewPath);
    const monitorIndex = viewSource.indexOf('/admin/monitor');
    assert.notEqual(monitorIndex, -1, `${viewPath} debe conservar enlace de Monitor para DEV.`);
    const beforeLink = viewSource.slice(Math.max(0, monitorIndex - 180), monitorIndex);
    assert.match(beforeLink, /role\s*===\s*['"]dev['"]/, `${viewPath} debe mantener Monitor solo para DEV.`);
  }
});

test('logo text is visible on dark navigation', () => {
  const logo = readSource('src/public/logo-loginpro.svg');
  assert.match(logo, /fill=["']#ffffff["']>LoginPro</);
});

test('dev vacancy panel filters candidate registrations by date and exports the same range', () => {
  const adminSource = readSource('src/routes/admin.js');
  const vacanciesView = readSource('src/views/vacancies.ejs');

  assert.match(adminSource, /function normalizeCandidateDateRangeFilter\(query = \{\}\)/);
  assert.match(adminSource, /createdAtWhere: Object\.keys\(createdAt\)\.length \? createdAt : null/);
  assert.match(adminSource, /function buildVacancyDevStats\(vacancies = \[\], candidates = \[\], dateFilter = \{\}\)/);
  assert.match(adminSource, /isOperationallyRegistered\(candidate\)/);
  assert.match(adminSource, /isOperationallyCompleteWithoutCv\(candidate\)/);
  assert.match(adminSource, /router\.get\(\s*['"]\/vacancies['"][\s\S]*?const dateFilter = normalizeCandidateDateRangeFilter\(req\.query\)/);
  assert.match(adminSource, /router\.get\(\s*['"]\/vacancies['"][\s\S]*?prisma\.candidate\.findMany\([\s\S]*?createdAt: dateFilter\.createdAtWhere/);
  assert.match(adminSource, /router\.get\(\s*['"]\/export['"][\s\S]*?const dateFilter = normalizeCandidateDateRangeFilter\(req\.query\)/);
  assert.match(adminSource, /router\.get\(\s*['"]\/export['"][\s\S]*?createdAt: dateFilter\.createdAtWhere/);

  assert.match(vacanciesView, /if \(role === 'dev'\)/);
  assert.match(vacanciesView, /Filtro dev de registros por fecha/);
  assert.match(vacanciesView, /name="dateFrom" type="date"/);
  assert.match(vacanciesView, /name="dateTo" type="date"/);
  assert.match(vacanciesView, /vacancyDevStats\.byVacancyId\[v\.id\]/);
  assert.match(vacanciesView, /Descargar total/);
  assert.match(vacanciesView, /scope=registered&vacancyId=<%= encodeURIComponent\(v\.id\) %><%= exportDateParams %>/);
  assert.match(vacanciesView, /scope=missing_cv_complete&vacancyId=<%= encodeURIComponent\(v\.id\) %><%= exportDateParams %>/);
});
