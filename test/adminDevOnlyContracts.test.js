import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('admin operations route remains protected by dev role', () => {
  const adminRouterSource = readSource('src/routes/admin.js');

  assert.match(
    adminRouterSource,
    /function\s+ensureDevRole\s*\([^)]*\)\s*{[\s\S]*?req\.userRole\s*!==\s*['"]dev['"][\s\S]*?403/,
    'ensureDevRole debe rechazar usuarios que no tengan rol dev con respuesta 403.'
  );

  assert.match(
    adminRouterSource,
    /router\.get\(\s*['"]\/operaciones['"]\s*,\s*ensureDevRole\s*,/,
    'GET /admin/operaciones debe mantenerse protegido por ensureDevRole.'
  );
});

test('dispatch module url is sanitized before rendering operations view', () => {
  const adminRouterSource = readSource('src/routes/admin.js');

  assert.match(
    adminRouterSource,
    /function\s+normalizeHttpUrl\s*\(/,
    'Debe existir normalizeHttpUrl para validar DISPATCH_MODULE_URL.'
  );

  assert.match(
    adminRouterSource,
    /\['http:',\s*'https:'\]\.includes\(url\.protocol\)/,
    'DISPATCH_MODULE_URL solo debe aceptar protocolos http y https.'
  );

  assert.match(
    adminRouterSource,
    /normalizeHttpUrl\(process\.env\.DISPATCH_MODULE_URL\)/,
    'La ruta de operaciones debe pasar DISPATCH_MODULE_URL por normalizeHttpUrl antes de renderizar.'
  );
});

test('operations view keeps pending-state fallback and opens dispatch through bridge route', () => {
  const operationsView = readSource('src/views/operaciones.ejs');

  assert.match(
    operationsView,
    /if\s*\(dispatchModuleUrl\)/,
    'La vista debe condicionar el boton externo a la existencia de dispatchModuleUrl.'
  );

  assert.match(
    operationsView,
    /Módulo pendiente de despliegue|Modulo pendiente de despliegue/,
    'La vista debe informar que el modulo esta pendiente cuando no existe DISPATCH_MODULE_URL.'
  );

  assert.match(
    operationsView,
    /href=['"]\/admin\/operaciones\/abrir['"]/, 
    'La vista debe abrir Dispatch por la ruta puente DEV-only.'
  );

  assert.doesNotMatch(
    operationsView,
    /target=['"]_blank['"]|rel=['"]noopener noreferrer['"]/, 
    'El modulo externo debe abrir en la misma pestaña del panel, no en una nueva.'
  );
});

test('dispatch bridge route remains dev-only and sanitizes destination url', () => {
  const serverSource = readSource('src/server.js');
  const bridgeSource = readSource('src/routes/dispatchBridge.js');

  assert.match(
    serverSource,
    /app\.use\(\s*['"]\/admin\/operaciones['"]\s*,\s*dispatchBridgeRouter\(\)\s*\)/,
    'El router puente debe montarse bajo /admin/operaciones antes del adminRouter general.'
  );

  assert.match(
    bridgeSource,
    /function\s+requireDevSession\s*\([^)]*\)\s*{[\s\S]*?role\s*!==\s*['"]dev['"][\s\S]*?403/,
    'La ruta puente debe rechazar usuarios no DEV con 403.'
  );

  assert.match(
    bridgeSource,
    /router\.get\(\s*['"]\/abrir['"]\s*,\s*requireDevSession\s*,/,
    'GET /admin/operaciones/abrir debe usar requireDevSession.'
  );

  assert.match(
    bridgeSource,
    /normalizeHttpUrl\(process\.env\.DISPATCH_MODULE_URL\)/,
    'La ruta puente debe validar DISPATCH_MODULE_URL antes de redirigir.'
  );

  assert.match(
    bridgeSource,
    /res\.redirect\(dispatchModuleUrl\)/,
    'La ruta puente debe redirigir a la URL validada del módulo.'
  );
});

test('dev-only navigation links are not exposed unconditionally', () => {
  const views = [
    'src/views/list.ejs',
    'src/views/vacancies.ejs',
    'src/views/detail.ejs',
    'src/views/users.ejs',
    'src/views/locations.ejs',
    'src/views/outreachApproved.ejs',
    'src/views/monitor.ejs'
  ];

  for (const viewPath of views) {
    const viewSource = readSource(viewPath);
    const operationsIndex = viewSource.indexOf('/admin/operaciones');

    assert.notEqual(
      operationsIndex,
      -1,
      `${viewPath} debe conservar el enlace de Operaciones / Despacho para DEV.`
    );

    const beforeLink = viewSource.slice(Math.max(0, operationsIndex - 250), operationsIndex);

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
