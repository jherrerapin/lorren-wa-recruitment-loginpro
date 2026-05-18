import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('dispatch client services can be managed and selected in operational requests', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const route = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const publicRoute = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const publicView = fs.readFileSync('src/views/publicDispatchRequest.ejs', 'utf8');
  const clientOpsView = fs.readFileSync('src/views/operacionesClienteOperaciones.ejs', 'utf8');
  const assignmentView = fs.readFileSync('src/views/operacionesAsignaciones.ejs', 'utf8');
  const editView = fs.readFileSync('src/views/operacionesSolicitudEditar.ejs', 'utf8');

  assert.match(schema, /model DispatchClientService/);
  assert.match(schema, /services\s+DispatchClientService\[\]/);
  assert.match(schema, /serviceId\s+String\?/);
  assert.match(schema, /serviceName\s+String\?/);
  assert.ok(fs.readdirSync('prisma/migrations').some((m) => m.includes('add_dispatch_client_services')));

  assert.match(route, /post\('\/clientes\/:clientId\/servicios'/);
  assert.match(route, /dispatchClientService\.create/);
  assert.match(route, /resolveDispatchService/);
  assert.match(route, /serviceRequestServiceData/);
  assert.match(publicRoute, /services:\s*\{/);
  assert.match(publicRoute, /serviceId: selectedService\?\.id/);

  assert.match(clientOpsView, /Crear servicio/);
  assert.match(clientOpsView, /Servicios registrados/);
  assert.match(publicView, /name="serviceId"/);
  assert.match(publicView, /Servicio solicitado/);
  assert.match(assignmentView, /Servicio del cliente/);
  assert.match(assignmentView, /Servicio:/);
  assert.match(editView, /name="serviceId"/);
});
