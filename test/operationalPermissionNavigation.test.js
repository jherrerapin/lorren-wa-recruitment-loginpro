import test from 'node:test';
import assert from 'node:assert/strict';
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';
import { requiredOperationalCapability } from '../src/services/dispatchAuditMiddleware.js';
import { OPERATIONAL_CAPABILITY } from '../src/services/operationalAccess.js';

const baseHtml = '<!DOCTYPE html><html><head><title>Operaciones</title></head><body><nav class="navbar"><a href="/admin">Panel</a></nav><main>Contenido</main></body></html>';

function request(effectivePermissions, extra = {}) {
  const session = {
    userRole: 'admin',
    canAccessDispatch: true,
    operationalAccessConfigured: true,
    operationalRole: 'CONSULTA',
    operationalEffectivePermissions: effectivePermissions,
    ...extra
  };
  return {
    originalUrl: '/admin/operaciones',
    userRole: 'admin',
    canAccessDispatch: true,
    operationalAccessConfigured: true,
    operationalRole: session.operationalRole,
    operationalEffectivePermissions: session.operationalEffectivePermissions,
    session
  };
}

function operationsMenu(html) {
  return html.match(/<details[^>]*data-module-menu="operations"[\s\S]*?<\/details>/)?.[0] || '';
}

test('Consulta no ve Crear solicitud cuando DISPATCH_REQUEST_MANAGE está deshabilitado', () => {
  const html = injectAdminModuleNavigation(baseHtml, request([
    OPERATIONAL_CAPABILITY.DISPATCH_VIEW
  ]));
  const menu = operationsMenu(html);

  assert.match(menu, /href="\/admin\/operaciones">Panel operativo<\/a>/);
  assert.doesNotMatch(menu, /href="\/admin\/operaciones\/solicitudes">Crear solicitud<\/a>/);
  assert.doesNotMatch(menu, /href="\/admin\/operaciones\/asignaciones">Asignación de auxiliares<\/a>/);

  const enabled = operationsMenu(injectAdminModuleNavigation(baseHtml, request([
    OPERATIONAL_CAPABILITY.DISPATCH_VIEW,
    OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE
  ])));
  assert.match(enabled, /href="\/admin\/operaciones\/solicitudes">Crear solicitud<\/a>/);
  assert.doesNotMatch(enabled, /href="\/admin\/operaciones\/asignaciones">Asignación de auxiliares<\/a>/);
});

test('usuarios históricos sin configuración operativa conservan el menú previo', () => {
  const html = injectAdminModuleNavigation(baseHtml, {
    originalUrl: '/admin/operaciones',
    userRole: 'admin',
    canAccessDispatch: true,
    session: { userRole: 'admin', canAccessDispatch: true, operationalAccessConfigured: false }
  });
  const menu = operationsMenu(html);
  assert.match(menu, /href="\/admin\/operaciones\/solicitudes">Crear solicitud<\/a>/);
  assert.match(menu, /href="\/admin\/operaciones\/asignaciones">Asignación de auxiliares<\/a>/);
});

test('la ruta de solicitudes exige la misma capacidad tanto para abrir como para guardar', () => {
  assert.equal(
    requiredOperationalCapability({ method: 'GET', originalUrl: '/admin/operaciones/solicitudes' }),
    OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE
  );
  assert.equal(
    requiredOperationalCapability({ method: 'POST', originalUrl: '/admin/operaciones/solicitudes' }),
    OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE
  );
  assert.equal(
    requiredOperationalCapability({ method: 'GET', originalUrl: '/admin/operaciones' }),
    OPERATIONAL_CAPABILITY.DISPATCH_VIEW
  );
});
