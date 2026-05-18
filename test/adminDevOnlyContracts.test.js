import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

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

test('admin user creation stores canAccessDispatch on normal recruiter users', () => {
  const adminSource = readSource('src/routes/admin.js');

  assert.match(adminSource, /router\.post\(\s*['"]\/users\/create['"]/);
  assert.match(adminSource, /const\s+canAccessDispatch\s*=\s*req\.body\.canAccessDispatch\s*===\s*['"]true['"]/);
  assert.match(adminSource, /prisma\.appUser\.create\([\s\S]*?data:\s*{[\s\S]*?username,[\s\S]*?role:\s*['"]ADMIN['"][\s\S]*?canAccessDispatch,/);
  assert.match(adminSource, /buildUniqueRecruiterUsername/);
});

test('users view has one form with dispatch checkbox and no operations-only form', () => {
  const usersView = readSource('src/views/users.ejs');

  assert.match(usersView, /name=["']canAccessDispatch["']/);
  assert.match(usersView, /id=["']canAccessDispatch["']/);
  assert.match(usersView, /value=["']true["']/);
  assert.match(usersView, /Permitir acceso a Operaciones \/ Despacho/);
  assert.match(usersView, /El usuario podrá entrar al panel operativo además del alcance de reclutamiento seleccionado\./);
  assert.match(usersView, /<%= user\.canAccessDispatch \? 'Operaciones \/ Despacho' : 'Reclutamiento' %>/);
  assert.doesNotMatch(usersView, /Crear usuario de Operaciones \/ Despacho/);
  assert.doesNotMatch(usersView, /\/admin\/users\/create-operations/);
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
