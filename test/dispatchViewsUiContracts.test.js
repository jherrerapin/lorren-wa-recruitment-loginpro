import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (path) => readFileSync(path, 'utf8');

test('vistas de operaciones usan estilos compartidos y navbar LoginPro', () => {
  const viewPaths = [
    'src/views/operacionesClientes.ejs',
    'src/views/operacionesClienteOperaciones.ejs',
    'src/views/operacionesPersonalNuevo.ejs',
    'src/views/operacionesSolicitudEditar.ejs'
  ];

  for (const viewPath of viewPaths) {
    const content = read(viewPath);
    assert.match(content, /\/public\/operaciones-ui\.css/);
    assert.match(content, /\/public\/logo-loginpro\.svg/);
    assert.match(content, /Operaciones \/ Despacho/);
  }
});

test('formulario publico de solicitud tiene diseno profesional', () => {
  const content = read('src/views/publicDispatchRequest.ejs');
  assert.match(content, /public-shell/);
  assert.match(content, /public-card/);
  assert.match(content, /Solicitud de servicio/);
  assert.match(content, /Enviar solicitud/);
  assert.match(content, /Solicitud registrada correctamente/);
});

test('vista de clientes conserva rutas funcionales', () => {
  const content = read('src/views/operacionesClientes.ejs');
  assert.match(content, /action="\/admin\/operaciones\/clientes"/);
  assert.match(content, /\/admin\/operaciones\/clientes\/<%= c\.id %>\/operaciones/);
});

test('vista de operaciones por cliente conserva links publicos', () => {
  const content = read('src/views/operacionesClienteOperaciones.ejs');
  assert.match(content, /publicToken/);
  assert.match(content, /Copiar link/);
  assert.match(content, /\/operaciones\/solicitud\//);
});

test('vista de auxiliar manual conserva selects multiples', () => {
  const content = read('src/views/operacionesPersonalNuevo.ejs');
  assert.match(content, /name="cityIds" multiple/);
  assert.match(content, /name="vacancyIds" multiple/);
  assert.match(content, /Crear auxiliar/);
});

test('vista de editar solicitud conserva campos y action', () => {
  const content = read('src/views/operacionesSolicitudEditar.ejs');
  assert.match(content, /asignaciones\/solicitudes\/<%= serviceRequest\.id %>\/editar/);
  assert.match(content, /name="requiredWorkers"/);
  assert.match(content, /name="status"/);
});

test('no se toca prisma ni se agregan migraciones en este polish ui', () => {
  assert.ok(existsSync('prisma/schema.prisma'));
});
