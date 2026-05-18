import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('operations entry is protected by the bridge router', () => {
  const serverSource = readSource('src/server.js');
  const bridgeSource = readSource('src/routes/dispatchBridge.js');

  assert.match(
    serverSource,
    /app\.use\(\s*['"]\/admin\/operaciones['"]\s*,\s*dispatchBridgeRouter\(\)\s*\)/,
    'El router de Operaciones debe montarse antes del adminRouter general.'
  );

  assert.match(
    bridgeSource,
    /function\s+requireOps\s*\([^)]*\)\s*{[\s\S]*?!role[\s\S]*?redirect\(['"]\/login['"]\)[\s\S]*?!canUseOps\(req\)[\s\S]*?403/,
    'La ruta de Operaciones debe exigir sesión y permiso operativo.'
  );

  assert.match(
    bridgeSource,
    /role\s*===\s*['"]dev['"]\s*\|\|\s*isOpsUser\(req\)/,
    'Operaciones debe permitir DEV o usuario operativo limitado.'
  );
});

test('dispatch module url is sanitized before redirecting', () => {
  const bridgeSource = readSource('src/routes/dispatchBridge.js');

  assert.match(
    bridgeSource,
    /function\s+normalizeHttpUrl\s*\(/,
    'Debe existir normalizeHttpUrl para validar DISPATCH_MODULE_URL.'
  );

  assert.match(
    bridgeSource,
    /\['http:',\s*'https:'\]\.includes\(url\.protocol\)/,
    'DISPATCH_MODULE_URL solo debe aceptar protocolos http y https.'
  );

  assert.match(
    bridgeSource,
    /normalizeHttpUrl\(process\.env\.DISPATCH_MODULE_URL\)/,
    'La ruta puente debe pasar DISPATCH_MODULE_URL por normalizeHttpUrl antes de redirigir.'
  );

  assert.match(
    bridgeSource,
    /res\.redirect\(dispatchModuleUrl\)/,
    'La ruta puente debe redirigir a la URL validada del módulo.'
  );
});

test('dispatch bridge opens operations directly without rendering the intermediate view', () => {
  const bridgeSource = readSource('src/routes/dispatchBridge.js');

  assert.match(
    bridgeSource,
    /router\.get\(\s*['"]\/['"]\s*,\s*requireOps[\s\S]*?res\.redirect\(['"]\/admin\/operaciones\/abrir['"]\)/,
    'GET /admin/operaciones debe redirigir directamente a /admin/operaciones/abrir.'
  );

  assert.match(
    bridgeSource,
    /router\.get\(\s*['"]\/abrir['"]\s*,\s*requireOps/,
    'GET /admin/operaciones/abrir debe mantenerse protegido por requireOps.'
  );

  assert.match(
    bridgeSource,
    /status\(503\)\.send\(['"]Panel operativo no configurado\.['"]\)/,
    'Si DISPATCH_MODULE_URL no es valida, /abrir debe responder 503 con texto simple.'
  );

  assert.doesNotMatch(
    bridgeSource,
    /res\.render\(['"]operaciones['"]/,
    'El router puente ya no debe renderizar operaciones.ejs en el flujo normal.'
  );

  assert.doesNotMatch(
    bridgeSource,
    /redirect\(['"]\/admin\/operaciones['"]\)/,
    '/abrir no debe devolver a la pantalla intermedia cuando falta DISPATCH_MODULE_URL.'
  );
});

test('operations access remains limited to DEV or operations-dispatch users', () => {
  const bridgeSource = readSource('src/routes/dispatchBridge.js');

  assert.match(
    bridgeSource,
    /function\s+requireOps\s*\([^)]*\)\s*{[\s\S]*?!role[\s\S]*?redirect\(['"]\/login['"]\)[\s\S]*?!canUseOps\(req\)[\s\S]*?403/,
    'La ruta de Operaciones debe exigir sesión y permiso operativo.'
  );

  assert.match(
    bridgeSource,
    /role\s*===\s*['"]dev['"]\s*\|\|\s*isOpsUser\(req\)/,
    'Operaciones debe permitir DEV o usuario operativo limitado.'
  );

  assert.match(
    bridgeSource,
    /startsWith\(['"]operaciones-despacho['"]\)/,
    'Los usuarios operativos deben identificarse por el prefijo operaciones-despacho.'
  );

  assert.doesNotMatch(
    bridgeSource,
    /role\s*===\s*['"]admin['"]|role\s*!==\s*['"]recruiter['"]/,
    'Un reclutador/admin normal no debe quedar autorizado por el rol.'
  );
});

test('operations-only users are redirected to operations and blocked from recruitment admin', () => {
  const serverSource = readSource('src/server.js');

  assert.match(
    serverSource,
    /function\s+isOperationsOnlyUsername\s*\(/,
    'Debe existir una función para identificar usuarios limitados a Operaciones.'
  );

  assert.match(
    serverSource,
    /startsWith\(['"]operaciones-despacho['"]\)/,
    'Los usuarios operativos deben identificarse con prefijo operaciones-despacho.'
  );

  assert.match(
    serverSource,
    /res\.redirect\(isOperationsOnlyUsername\(sessionPayload\.username\)\s*\?\s*['"]\/admin\/operaciones\/abrir['"]\s*:\s*['"]\/admin['"]\)/,
    'El login debe redirigir usuarios operativos directamente a Operaciones / Despacho.'
  );

  assert.match(
    serverSource,
    /Usuario limitado a Operaciones \/ Despacho/,
    'Los usuarios operativos no deben navegar el dashboard de reclutamiento.'
  );
});

test('dev can open and submit operations-only user creation without changing the database schema', () => {
  const serverSource = readSource('src/server.js');
  const usersView = readSource('src/views/users.ejs');

  assert.match(
    serverSource,
    /app\.get\(\s*['"]\/admin\/users\/create-operations['"]/,
    'Debe existir un formulario GET para crear usuarios de Operaciones desde el panel.'
  );

  assert.match(
    serverSource,
    /if\s*\(\s*!req\.session\?\.userRole\s*\)\s*return\s+res\.redirect\(['"]\/login['"]\)/,
    'El formulario GET debe redirigir a /login cuando no hay sesión.'
  );

  assert.match(
    serverSource,
    /req\.session\.userRole\s*!==\s*['"]dev['"]/,
    'El formulario GET debe estar restringido a DEV.'
  );

  assert.match(
    serverSource,
    /app\.post\(\s*['"]\/admin\/users\/create-operations['"]/,
    'Debe existir un endpoint para crear usuarios de Operaciones desde el panel.'
  );

  assert.match(
    serverSource,
    /req\.session\?\.userRole\s*!==\s*['"]dev['"]/,
    'La creación de usuarios operativos debe estar restringida a DEV.'
  );

  assert.match(
    serverSource,
    /role:\s*['"]ADMIN['"][\s\S]*?accessScope:\s*['"]ALL['"]/,
    'El usuario operativo se crea como AppUser existente, sin migración nueva.'
  );

  const operationsCreateIndex = usersView.indexOf('/admin/users/create-operations');

  assert.notEqual(
    operationsCreateIndex,
    -1,
    'La vista de usuarios debe enlazar el formulario de Operaciones / Despacho.'
  );

  const beforeLink = usersView.slice(Math.max(0, operationsCreateIndex - 250), operationsCreateIndex);

  assert.match(
    beforeLink,
    /role\s*===\s*['"]dev['"]|role\s*==\s*['"]dev['"]/,
    'El enlace para crear usuarios operativos debe mostrarse solo para DEV.'
  );
});

test('dev-only navigation links are not exposed unconditionally', () => {
  const serverSource = readSource('src/routes/admin.js');
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
    const operationsIndex = viewSource.indexOf('/admin/operaciones/abrir');

    assert.notEqual(
      operationsIndex,
      -1,
      `${viewPath} debe conservar el enlace directo de Operaciones / Despacho para DEV.`
    );

    const directOperationsLink = new RegExp(`<a[^>]+href=[\"']\/admin\/operaciones\/abrir[\"'][^>]*>\\s*Operaciones \/ Despacho`);
    const operationsLinkMatch = viewSource.match(directOperationsLink);

    assert.ok(
      operationsLinkMatch,
      `${viewPath} debe enlazar Operaciones / Despacho directamente a /admin/operaciones/abrir.`
    );

    assert.doesNotMatch(
      operationsLinkMatch[0],
      /target=[\"']_blank[\"']/,
      `${viewPath} debe abrir Operaciones / Despacho en la misma pestaña.`
    );

    const beforeLink = viewSource.slice(Math.max(0, operationsIndex - 250), operationsIndex);
    const isDevOnlyView = [
      'src/views/monitor.ejs',
      'src/views/botKnowledge.ejs'
    ].includes(viewPath) && new RegExp(`router\\.get\\(\\s*['\"]\/${viewPath.includes('monitor') ? 'monitor' : 'bot-knowledge'}['\"]\\s*,\\s*ensureDevRole`).test(serverSource);

    if (isDevOnlyView) continue;

    assert.match(
      beforeLink,
      /role\s*===\s*['"]dev['"]|role\s*==\s*['"]dev['"]/,
      `${viewPath} debe envolver el enlace de Operaciones / Despacho en una condicion de rol dev.`
    );
  }
});

test('environment documentation keeps dispatch module url documented as optional', () => {
  const readme = readSource('README.md');
  const envExample = readSource('.env.example');

  assert.match(readme, /DISPATCH_MODULE_URL/, 'README debe documentar DISPATCH_MODULE_URL.');
  assert.match(envExample, /DISPATCH_MODULE_URL/, '.env.example debe incluir DISPATCH_MODULE_URL.');
  assert.match(
    readme,
    /solo DEV|DEV-only|perfil DEV/i,
    'README debe indicar que Operaciones / Despacho es una seccion restringida a DEV.'
  );
});
