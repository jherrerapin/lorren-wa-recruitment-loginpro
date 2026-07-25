import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('dispatch operations UX rules for delete, time inputs, manual CV and dependent vacancies', () => {
  const publicRoute = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const dispatchRoute = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const dispatchCoreRoute = fs.readFileSync('src/routes/dispatchBridgeCore.js', 'utf8');
  const dashboardMetricsRoute = fs.readFileSync('src/routes/dispatchDashboardMetrics.js', 'utf8');
  const clientsView = fs.readFileSync('src/views/operacionesClientes.ejs', 'utf8');
  const clientOpsView = fs.readFileSync('src/views/operacionesClienteOperaciones.ejs', 'utf8');
  const personalView = fs.readFileSync('src/views/operacionesPersonal.ejs', 'utf8');
  const workerFormView = fs.readFileSync('src/views/operacionesPersonalNuevo.ejs', 'utf8');
  const assignmentsView = fs.readFileSync('src/views/operacionesAsignaciones.ejs', 'utf8');
  const editRequestView = fs.readFileSync('src/views/operacionesSolicitudEditar.ejs', 'utf8');
  const publicRequestView = fs.readFileSync('src/views/publicDispatchRequest.ejs', 'utf8');

  assert.match(publicRoute, /runDelete/);
  assert.match(publicRoute, /isKnownDeleteConstraintError/);
  assert.match(publicRoute, /dispatchClient\.delete/);
  assert.match(publicRoute, /dispatchOperationPoint\.delete/);
  assert.match(publicRoute, /dispatchClientService\.delete/);
  assert.match(publicRoute, /dispatchWorker\.delete/);
  assert.match(publicRoute, /No fue posible eliminar/);

  assert.match(publicRequestView, /id="startTime" type="time" name="startTime"/);
  assert.match(publicRequestView, /id="endTime" type="time" name="endTime"/);
  assert.match(assignmentsView, /type="time" name="startTime"/);
  assert.match(assignmentsView, /type="time" name="endTime"/);
  assert.match(editRequestView, /id="startTime" type="time" name="startTime"/);
  assert.match(editRequestView, /id="endTime" type="time" name="endTime"/);
  assert.match(publicRoute, /TIME_HH_MM_PATTERN/);
  assert.match(publicRoute, /normalizeOptionalTime/);
  assert.match(publicRoute, /Horario invalido\. Usa formato HH:mm/);
  assert.match(publicRoute, /startTime,\r?\n\s*endTime/);
  assert.match(dispatchCoreRoute, /TIME_HH_MM_PATTERN/);
  assert.match(dispatchCoreRoute, /normalizeOptionalTime/);
  assert.match(dispatchCoreRoute, /resolveRequestTimes/);
  assert.match(dispatchCoreRoute, /Horario invalido\. Usa formato HH:mm/);
  assert.match(dispatchCoreRoute, /\.\.\.requestTimes/);
  assert.match(dashboardMetricsRoute, /buildDispatchServiceDateWhere/);
  assert.match(dashboardMetricsRoute, /filterDispatchServiceRequestsByDate/);

  assert.match(workerFormView, /enctype="multipart\/form-data"/);
  assert.match(workerFormView, /name="cvFile"/);
  assert.match(workerFormView, /accept="\.pdf,\.doc,\.docx/);
  assert.match(publicRoute, /workerCvUpload\.single\('cvFile'\)/);
  assert.match(publicRoute, /saveWorkerCv/);
  assert.match(publicRoute, /cvOriginalName/);
  assert.match(publicRoute, /cvMimeType/);
  assert.match(publicRoute, /cvData/);

  assert.match(workerFormView, /Selecciona una ciudad para ver perfiles disponibles/);
  assert.match(workerFormView, /refreshVacancyOptions/);
  assert.match(workerFormView, /data-city-name/);
  assert.match(publicRoute, /validateVacanciesForSelectedCities/);
  assert.match(publicRoute, /isActive:\s*true/);
  assert.match(publicRoute, /Uno o más perfiles no pertenecen a las ciudades seleccionadas o no están activos/);

  assert.doesNotMatch(clientsView, /Acciones CRUD/);
  assert.doesNotMatch(clientOpsView, /Acciones CRUD/);
  assert.doesNotMatch(personalView, /Acciones CRUD/);

  assert.match(clientsView, /onsubmit="return confirm\('¿Eliminar este cliente\?/);
  assert.match(clientOpsView, /Eliminar/);
  assert.match(personalView, />Acciones<\/th>/);
  assert.match(personalView, /<th>Estado<\/th>/);
  assert.match(personalView, /operationalStatus === 'CONTRATADO'/);

  assert.doesNotMatch(dispatchRoute, /DISPATCH_MODULE_URL/);
  assert.doesNotMatch(publicRoute, /conversationEngine|webhook|whatsapp/i);
});
