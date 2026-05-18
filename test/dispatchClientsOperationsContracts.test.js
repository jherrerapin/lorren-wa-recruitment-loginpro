import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('dispatch clients operations contracts', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const route = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const publicRoute = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const server = fs.readFileSync('src/server.js', 'utf8');
  const view = fs.readFileSync('src/views/operacionesAsignaciones.ejs', 'utf8');

  assert.match(schema, /model DispatchClient/);
  assert.match(schema, /model DispatchOperationPoint/);
  assert.match(schema, /model DispatchClient[\s\S]*publicToken\s+String\s+@unique/);
  assert.match(schema, /model DispatchOperationPoint[\s\S]*publicToken\s+String\s+@unique/);
  assert.match(schema, /operationPointId/);
  assert.ok(fs.readdirSync('prisma/migrations').some((m) => m.includes('add_dispatch_clients_operations_public_requests')));
  assert.ok(fs.readdirSync('prisma/migrations').some((m) => m.includes('add_dispatch_client_public_token')));

  ["get('/clientes'", "post('/clientes'", "get('/clientes/:clientId/operaciones'", "post('/clientes/:clientId/operaciones'", "get('/solicitud/:publicToken'", "post('/solicitud/:publicToken'", "get('/personal/nuevo'", "post('/personal/nuevo'", "get('/asignaciones/solicitudes/:id/editar'", "post('/asignaciones/solicitudes/:id/editar'"]
    .forEach((s) => assert.match(route, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));

  assert.match(publicRoute, /get\('\/cliente\/:publicToken'/);
  assert.match(publicRoute, /post\('\/cliente\/:publicToken'/);
  assert.match(publicRoute, /operationPointId/);
  assert.match(publicRoute, /findClientByLegacyOperationToken/);
  assert.match(server, /app\.use\('\/operaciones', publicDispatchClientRouter\(\)\)/);

  ['worker-list', 'max-height', 'request-list', 'Clientes', 'Solicitudes de servicio', 'Crear solicitud interna'].forEach((s) => assert.match(view, new RegExp(s)));
  assert.match(view, /overflow-y:\s*auto/);

  const clientsView = fs.readFileSync('src/views/operacionesClientes.ejs', 'utf8');
  const clientOpsView = fs.readFileSync('src/views/operacionesClienteOperaciones.ejs', 'utf8');
  const publicView = fs.readFileSync('src/views/publicDispatchRequest.ejs', 'utf8');
  assert.match(clientsView, /Link público del cliente/);
  assert.match(clientOpsView, /link público del cliente/);
  assert.match(publicView, /name="operationPointId"/);

  ['src/views/operacionesClientes.ejs','src/views/operacionesClienteOperaciones.ejs','src/views/publicDispatchRequest.ejs','src/views/operacionesPersonalNuevo.ejs','src/views/operacionesSolicitudEditar.ejs'].forEach((f)=>assert.ok(fs.existsSync(f)));
  assert.doesNotMatch(route, /webhook/i);
  assert.doesNotMatch(route, /conversationEngine/i);
});
