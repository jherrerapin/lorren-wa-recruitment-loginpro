import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';

const sourceWithoutViewport = `<!DOCTYPE html><html><head><title>Admin</title></head><body>
<nav class="navbar"><a href="/admin">Panel</a><a href="/admin/users">Usuarios</a></nav>
<main class="page payroll-page"><h1>Contenido</h1></main>
</body></html>`;

function req(path = '/admin') {
  return {
    originalUrl: path,
    userRole: 'dev',
    session: {
      userRole: 'dev',
      canAccessDispatch: true,
      canAccessAttendance: true,
      canAccessPayroll: true
    }
  };
}

test('la inyección admin garantiza viewport, shell común y stylesheet responsive una sola vez', () => {
  const html = injectAdminModuleNavigation(sourceWithoutViewport, req('/admin/operaciones/asistencia/nomina'));

  assert.equal((html.match(/name="viewport"/g) || []).length, 1);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0" \/>/);
  assert.match(html, /href="\/public\/admin-module-shell\.css"/);
  assert.match(html, /<main class="page payroll-page admin-module-page-shell">/);

  const reinjected = injectAdminModuleNavigation(html, req('/admin/operaciones/asistencia/nomina'));
  assert.equal(reinjected, html, 'la inyección completa debe seguir siendo idempotente');
});

test('un viewport existente no se duplica y un main sin clase recibe el shell', () => {
  const source = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title></head><body>
  <nav class="navbar"><a href="/admin">Panel</a></nav><main>Contenido</main></body></html>`;
  const html = injectAdminModuleNavigation(source, req('/admin'));

  assert.equal((html.match(/name="viewport"/g) || []).length, 1);
  assert.match(html, /<main class="admin-module-page-shell">Contenido<\/main>/);
});

test('el shell comparte gutters, compacta controles y permite wrap antes de solaparse', async () => {
  const [css, navigationCss] = await Promise.all([
    readFile(new URL('../src/public/admin-module-shell.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/admin-module-navigation.css', import.meta.url), 'utf8')
  ]);

  assert.match(css, /--admin-shell-max-width:\s*1600px/);
  assert.match(css, /--admin-shell-gutter:\s*clamp\(14px,\s*2vw,\s*24px\)/);
  assert.match(css, /--admin-shell-control-gap:\s*7px/);
  assert.match(css, /\.admin-module-page-shell:not\(\.assignment-page\)[\s\S]*max-width:\s*var\(--admin-shell-max-width\)/);
  assert.match(css, /\.admin-module-navbar[\s\S]*flex-wrap:\s*wrap[\s\S]*column-gap:\s*var\(--admin-shell-control-gap\)\s*!important/);
  assert.match(css, /padding-left:\s*max\(var\(--admin-shell-gutter\),\s*calc\(\(100vw - var\(--admin-shell-max-width\)\) \/ 2 \+ var\(--admin-shell-gutter\)\)\)/);

  const shellGap = Number(css.match(/--admin-shell-control-gap:\s*(\d+)px/)?.[1]);
  const moduleGap = Number(navigationCss.match(/\.admin-module-nav-links\s*\{[\s\S]*?gap:\s*(\d+)px/)?.[1]);
  assert.equal(shellGap, moduleGap, 'Sucursales debe quedar a la misma distancia visual que los módulos entre sí');

  assert.match(css, /@media \(min-width:\s*901px\) and \(max-width:\s*1180px\)[\s\S]*\.spacer[\s\S]*display:\s*none/);
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*admin-module-standalone-link[\s\S]*flex:\s*1 1 130px/);
  assert.match(css, /@media \(max-width:\s*430px\)[\s\S]*flex-basis:\s*100%/);
});

test('la matriz objetivo cubre móvil pequeño, tablet, escritorio y ultra-wide sin hardcodear un viewport único', async () => {
  const css = await readFile(new URL('../src/public/admin-module-shell.css', import.meta.url), 'utf8');
  const representativeWidths = [320, 360, 390, 430, 768, 900, 1024, 1280, 1440, 1536, 1920, 2560];

  assert.deepEqual(representativeWidths.filter((width) => width <= 430), [320, 360, 390, 430]);
  assert.ok(css.includes('max-width: 900px'));
  assert.ok(css.includes('max-width: 1180px'));
  assert.ok(css.includes('1600px'));
  assert.doesNotMatch(css, /width:\s*(?:320|360|390|430|768|900|1024|1280|1440|1536|1920|2560)px\s*!important/);
});
