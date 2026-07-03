import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('dispatch CRUD contracts for clients operations services and every worker source', () => {
  const route = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const publicRoute = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const opsExtrasRoute = fs.readFileSync('src/routes/dispatchOpsExtras.js', 'utf8');
  const deleteRoute = fs.readFileSync('src/routes/dispatchDeleteRouter.js', 'utf8');
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
  assert.match(route, /findWorkerOr404/);
  assert.match(route, /dispatchOperationPoint\.update/);
  assert.match(route, /dispatchClientService\.update/);
  assert.match(route, /regenerar-link/);

  ['Editar', 'Desactivar', 'Reactivar', 'Regenerar link', 'Eliminar'].forEach((label) => assert.match(clientsView, new RegExp(label)));
  assert.doesNotMatch(clientsView, /Acciones CRUD/);
  ['Editar operación', 'Editar servicio', 'Guardar operación', 'Guardar servicio', 'Eliminar'].forEach((label) => assert.match(clientOpsView, new RegExp(label)));
  ['Editar', 'Desactivar', 'Reactivar', 'Eliminar', 'MANUAL'].forEach((label) => assert.match(personalView, new RegExp(label)));
  assert.doesNotMatch(personalView, /if \(w\.source === 'MANUAL'\)/);
  assert.match(personalView, /\/operaciones\/admin-worker\/<%= w\.id %>\/editar/);
  ['mode ===', 'formAction', 'selectedCityIds', 'selectedVacancyIds', 'operationalStatus', 'Datos del panel del bot', 'medicalRestrictions', 'experienceInfo', 'experienceTime', 'experienceSummary'].forEach((label) => assert.match(workerFormView, new RegExp(label)));
  assert.match(workerFormView, /Hoja de vida, medio de transporte y notas operativas son opcionales/);
  assert.match(workerFormView, /<select id="residenceCity" name="residenceCity" required>/);
  assert.match(workerFormView, /cities\.forEach\(\(city\) =>/);
  assert.doesNotMatch(workerFormView, /<input id="residenceCity"/);

  assert.match(publicRoute, /findWorkerOr404/);
  assert.match(publicRoute, /include: \{ cities: true, vacancies: true, candidate: true \}/);
  assert.match(publicRoute, /buildCandidateProfileData/);
  assert.match(publicRoute, /prisma\.candidate\.update/);
  assert.doesNotMatch(publicRoute, /where: \{ id: workerId, source: 'MANUAL' \}/);
  assert.match(opsExtrasRoute, /DISPATCH_OWNED_SOURCES = \['MANUAL', 'EXCEL_IMPORT', 'CANDIDATE'\]/);
  assert.doesNotMatch(opsExtrasRoute, /findManualWorkerOr404|Auxiliar manual no encontrado|Auxiliar manual actualizado/);
  assert.doesNotMatch(deleteRoute, /source: 'MANUAL'|Auxiliar manual no encontrado|Auxiliar manual eliminado/);

  assert.doesNotMatch(route, /DISPATCH_MODULE_URL/);
  assert.doesNotMatch(route, /conversationEngine|webhook|whatsapp/i);
});
