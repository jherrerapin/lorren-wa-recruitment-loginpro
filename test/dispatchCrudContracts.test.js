import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('dispatch CRUD contracts for clients operations services and manual workers', () => {
  const route = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const clientsView = fs.readFileSync('src/views/operacionesClientes.ejs', 'utf8');
  const clientOpsView = fs.readFileSync('src/views/operacionesClienteOperaciones.ejs', 'utf8');
  const personalView = fs.readFileSync('src/views/operacionesPersonal.ejs', 'utf8');
  const workerFormView = fs.readFileSync('src/views/operacionesPersonalNuevo.ejs', 'utf8');

  [
    "get('/clientes/:clientId/editar'",
    "post('/clientes/:clientId/editar'",
    "post('/clientes/:clientId/toggle'",
    "post('/clientes/:clientId/regenerar-link'",
    "post('/clientes/:clientId/eliminar'",
    "post('/clientes/:clientId/operaciones/:operationId/editar'",
    "post('/clientes/:clientId/operaciones/:operationId/toggle'",
    "post('/clientes/:clientId/operaciones/:operationId/eliminar'",
    "post('/clientes/:clientId/servicios/:serviceId/editar'",
    "post('/clientes/:clientId/servicios/:serviceId/toggle'",
    "post('/clientes/:clientId/servicios/:serviceId/eliminar'",
    "get('/personal/:workerId/editar'",
    "post('/personal/:workerId/editar'",
    "post('/personal/:workerId/toggle'",
    "post('/personal/:workerId/eliminar'"
  ].forEach((s) => assert.match(route, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));

  assert.match(route, /source:\s*'MANUAL'/);
  assert.match(route, /findManualWorkerOr404/);
  assert.match(route, /dispatchOperationPoint\.update/);
  assert.match(route, /dispatchClientService\.update/);
  assert.match(route, /regenerar-link/);

  ['Editar', 'Desactivar', 'Reactivar', 'Regenerar link', 'Eliminar', 'Acciones CRUD'].forEach((label) => assert.match(clientsView, new RegExp(label)));
  ['Editar operación', 'Editar servicio', 'Guardar operación', 'Guardar servicio', 'Eliminar'].forEach((label) => assert.match(clientOpsView, new RegExp(label)));
  ['Editar', 'Desactivar', 'Reactivar', 'Eliminar', 'MANUAL'].forEach((label) => assert.match(personalView, new RegExp(label)));
  ['mode ===', 'formAction', 'selectedCityIds', 'selectedVacancyIds', 'operationalStatus'].forEach((label) => assert.match(workerFormView, new RegExp(label)));

  assert.doesNotMatch(route, /DISPATCH_MODULE_URL/);
  assert.doesNotMatch(route, /conversationEngine|webhook|whatsapp/i);
});
