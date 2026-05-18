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
    'La vista debe abrir Dispatch por la ruta puente del panel.'
  );

  assert.doesNotMatch(
    operationsView,
    /target=['"]_blank['"]|rel=['"]noopener noreferrer['"]/, 
    'El modulo externo debe abrir en la misma pestaña del panel, no en una nueva.'
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
    /res\.redirect\(isOperationsOnlyUsername\(sessionPayload\.username\)\s*\?\s*['"]\/admin\/operaciones['"]\s*:\s*['"]\/admin['"]\)/,
    'El login debe redirigir usuarios operativos directamente a Operaciones.'
  );

  assert.match(
    serverSource,
    /Usuario limitado a Operaciones \/ Despacho/,
    'Los usuarios operativos no deben navegar el dashboard de reclutamiento.'
  );
});

test('dev can create operations-only users without changing the database schema', () => {
  const serverSource = readSource('src/server.js');

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
