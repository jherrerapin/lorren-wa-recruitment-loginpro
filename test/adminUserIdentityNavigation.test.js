import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ejs from 'ejs';
import { buildAdminModuleNavbar } from '../src/services/adminNavigation.js';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function primaryGroup(html) {
  return html.match(/<div class="admin-module-nav-links" data-primary-nav-group="true">([\s\S]*?)<\/div>\s*<span class="spacer">/)?.[1] || '';
}

test('el nombre humano enlaza Mi perfil fuera de módulos y no expone el correo', () => {
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
  assert.match(html, /href="\/account\/profile"/);
  assert.match(html, />Mi perfil<\/span>/);
  assert.match(html, />Persona de Prueba<\/span>/);
  assert.doesNotMatch(html, /persona@example\.test/);
  assert.doesNotMatch(primaryGroup(html), /Persona de Prueba|Mi perfil/);
  assert.match(html, /<span class="spacer"><\/span>\s*<a class="admin-session-identity"/);
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

test('DEV puede entrar como la cuenta administrativa heredada sin habilitar sus acciones protegidas', () => {
  const template = readSource('src/views/users.ejs');
  const legacyAdmin = {
    id: 'legacy-admin-1',
    username: 'legacy-env-admin',
    displayName: 'Administración Heredada',
    email: 'legacy.admin@example.test',
    identityMigratedAt: new Date('2026-08-20T12:00:00.000Z'),
    createdByUsername: 'system',
    accessScope: 'ALL',
    scopeCity: null,
    scopeVacancyId: null,
    canAccessDispatch: false,
    canAccessAttendance: false,
    canAccessMetaAds: false,
    canAccessCvAnalysis: false,
    isActive: true,
    lastPasswordResetAt: null,
    recoveryPhone: null,
    recoveryEmail: 'legacy.admin@example.test'
  };
  const html = ejs.render(template, {
    role: 'dev',
    canAccessDispatch: true,
    canCreateUsers: false,
    canManageUsers: true,
    canManageModulePermissions: true,
    canImpersonateUsers: true,
    users: [legacyAdmin],
    vacancies: [],
    manageableScopeOptions: { allowedCities: [], allowedVacancies: [], canCreateAll: true },
    describeUserScope: () => 'Todas las vacantes',
    successMsg: null,
    errorMsg: null,
    revealedRecoveryCode: null,
    highlightedUserId: null,
    highlightedUser: null,
    currentUsername: 'dev-env',
    currentUserId: 'dev-1',
    environmentAdminUsername: 'legacy-env-admin'
  });

  assert.match(html, /action="\/admin\/users\/legacy-admin-1\/impersonate"/);
  assert.match(html, />Entrar como usuario<\/button>/);
  assert.match(html, /Perfil principal configurado por entorno/);
  assert.doesNotMatch(html, /\/admin\/users\/legacy-admin-1\/toggle/);
  assert.doesNotMatch(html, /\/admin\/users\/legacy-admin-1\/reset-password/);
});

test('la vista impersonada muestra retorno explícito a DEV sin correo ni edición de perfil', () => {
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
  assert.doesNotMatch(html, /\/account\/profile/);
});

test('el responsive coloca identidad en fila propia antes de módulos sin posicionamiento forzado', () => {
  const css = readSource('src/public/admin-module-shell.css');

  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.admin-session-identity\s*\{[\s\S]*?order:\s*2;[\s\S]*?width:\s*100%;/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.admin-module-navbar \.admin-module-nav-links\s*\{[\s\S]*?order:\s*3;[\s\S]*?width:\s*100%;/);
  const identityBlock = css.match(/\.admin-session-identity\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.doesNotMatch(identityBlock, /position:\s*absolute|margin-left:\s*-|transform:\s*translate/);
});