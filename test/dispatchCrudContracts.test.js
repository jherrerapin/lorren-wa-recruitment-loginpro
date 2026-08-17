import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('dispatch CRUD conserva clientes y personal con sucursal como autoridad territorial', () => {
  const route = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const coreRoute = fs.readFileSync('src/routes/dispatchBridgeCore.js', 'utf8');
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
  ].forEach((value) => assert.match(coreRoute, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));

  assert.match(coreRoute, /source:\s*'MANUAL'/);
  assert.match(coreRoute, /findWorkerOr404/);
  assert.match(coreRoute, /dispatchOperationPoint\.update/);
  assert.match(coreRoute, /dispatchClientService\.update/);
  assert.match(coreRoute, /regenerar-link/);

  ['Editar', 'Desactivar', 'Reactivar', 'Regenerar link', 'Eliminar'].forEach((label) => assert.match(clientsView, new RegExp(label)));
  assert.doesNotMatch(clientsView, /Configurar ciudades|Bot y Despacho|Bot \/ Reclutamiento/);
  assert.match(clientsView, /href="\/admin\/locations">Sucursales/);
  ['Editar operación', 'Editar servicio', 'Guardar operación', 'Guardar servicio', 'Eliminar'].forEach((label) => assert.match(clientOpsView, new RegExp(label)));

  ['Editar', 'Desactivar', 'Eliminar'].forEach((label) => assert.match(personalView, new RegExp(label)));
  assert.doesNotMatch(personalView, /if \(w\.source === 'MANUAL'\)/);
  assert.match(personalView, /\/operaciones\/admin-worker\/<%= w\.id %>\/editar/);
  assert.match(personalView, /\/operaciones\/admin-worker\/nuevo/);
  assert.doesNotMatch(personalView, /Vacantes \/ perfiles|name="vacancyId"/);

  ['mode ===', 'formAction', 'selectedCityIds', 'operationalStatus', 'Datos del panel del bot', 'medicalRestrictions', 'experienceInfo', 'experienceTime', 'experienceSummary'].forEach((label) => assert.match(workerFormView, new RegExp(label)));
  assert.match(workerFormView, /Sucursales habilitadas/);
  assert.match(workerFormView, /<select id="residenceCity" name="residenceCity" required>/);
  assert.doesNotMatch(workerFormView, /selectedVacancyIds|name="vacancyIds"|Vacantes \/ perfiles/);
  assert.doesNotMatch(workerFormView, /<input id="residenceCity"/);

  // El CRUD canónico de auxiliar valida y escribe exclusivamente Sucursales.
  assert.match(publicRoute, /validateSelectedBranches/);
  assert.match(publicRoute, /createWorkerWithBranches/);
  assert.match(publicRoute, /updateWorkerWithBranches/);
  assert.match(publicRoute, /dispatchWorkerCity\.createMany/);
  assert.match(publicRoute, /loadUnifiedCityOptions/);
  assert.doesNotMatch(publicRoute, /resolveEquivalentCityIds|validateVacanciesForSelectedCities/);
  assert.doesNotMatch(publicRoute, /body\.vacancyIds|dispatchWorkerVacancy\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)/);
  assert.doesNotMatch(publicRoute, /usedForDispatch/);
  assert.match(publicRoute, /buildCandidateProfileData/);
  assert.doesNotMatch(publicRoute, /where: \{ id: workerId, source: 'MANUAL' \}/);

  // Las rutas legacy siguen presentes durante transición, pero ya no están enlazadas por la UI canónica.
  assert.match(opsExtrasRoute, /DISPATCH_OWNED_SOURCES = \['MANUAL', 'EXCEL_IMPORT', 'CANDIDATE'\]/);
  assert.doesNotMatch(deleteRoute, /source: 'MANUAL'|Auxiliar manual no encontrado|Auxiliar manual eliminado/);

  assert.doesNotMatch(route, /DISPATCH_MODULE_URL/);
  assert.doesNotMatch(route, /conversationEngine|webhook|whatsapp/i);
});