import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAdminModuleNavbar } from '../src/services/adminNavigation.js';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function primaryGroup(html) {
  return html.match(/<div class="admin-module-nav-links" data-primary-nav-group="true">([\s\S]*?)<\/div>\s*<span class="spacer">/)?.[1] || '';
}

test('el nombre humano se muestra fuera del grupo de módulos y no expone el correo', () => {
  const html = buildAdminModuleNavbar({
    originalUrl: '/admin',
    session: {
      userRole: 'admin',
      userSource: 'db',
      username: 'user-internal',
      displayName: 'Persona de Prueba',
      userEmail: 'persona@example.test',
      canAccessDispatch: false
    }
  });

  assert.match(html, /data-session-identity="true"/);
  assert.match(html, />Persona de Prueba<\/span>/);
  assert.doesNotMatch(html, /persona@example\.test/);
  assert.doesNotMatch(primaryGroup(html), /Persona de Prueba/);
  assert.match(html, /<span class="spacer"><\/span>\s*<div class="admin-session-identity"/);
});

test('un reclutador ordinario ve Usuarios como módulo de creación', () => {
  const html = buildAdminModuleNavbar({
    originalUrl: '/admin',
    session: {
      userRole: 'admin',
      userSource: 'db',
      username: 'legacy-ordinary',
      displayName: 'Reclutador Prueba',
      userAccessScope: 'CITY'
    }
  });

  assert.match(primaryGroup(html), /data-standalone-link="users"/);
});

test('la vista impersonada muestra retorno explícito a DEV sin correo', () => {
  const html = buildAdminModuleNavbar({
    originalUrl: '/admin',
    session: {
      userRole: 'admin',
      userSource: 'db',
      username: 'user-target',
      displayName: 'Persona Objetivo',
      userEmail: 'objetivo@example.test',
      devImpersonation: {
        origin: { userRole: 'dev', username: 'dev-env' },
        targetUserId: 'target-1'
      }
    }
  });

  assert.match(html, /class="admin-session-identity is-impersonating"/);
  assert.match(html, />Vista como<\/span>/);
  assert.match(html, />Persona Objetivo<\/strong>/);
  assert.match(html, /action="\/admin\/users\/impersonation\/stop"/);
  assert.match(html, />Volver a DEV<\/button>/);
  assert.doesNotMatch(html, /objetivo@example\.test/);
});

test('el responsive coloca identidad en fila propia antes de módulos sin posicionamiento forzado', () => {
  const css = readSource('src/public/admin-module-shell.css');

  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.admin-session-identity\s*\{[\s\S]*?order:\s*2;[\s\S]*?width:\s*100%;/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.admin-module-navbar \.admin-module-nav-links\s*\{[\s\S]*?order:\s*3;[\s\S]*?width:\s*100%;/);
  const identityBlock = css.match(/\.admin-session-identity\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.doesNotMatch(identityBlock, /position:\s*absolute|margin-left:\s*-|transform:\s*translate/);
});
