import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeProgrammingIncludePending,
  selectProgrammingRequests
} from '../src/services/dispatchProgrammingPdfService.js';

const requests = [
  { id: 'complete', status: 'ASSIGNMENT_COMPLETE' },
  { id: 'confirmation', status: 'PENDING_CONFIRMATION' },
  { id: 'partial', status: 'ASSIGNMENT_PARTIAL' },
  { id: 'unassigned', status: 'PENDING_ASSIGNMENT' }
];

test('programación confirmada selecciona únicamente solicitudes completas', () => {
  const selected = selectProgrammingRequests(requests, { includePending: false });
  assert.deepEqual(selected.map((request) => request.id), ['complete']);
  assert.notEqual(selected, requests);
});

test('programación con pendientes conserva todas las solicitudes del día', () => {
  const selected = selectProgrammingRequests(requests, { includePending: true });
  assert.deepEqual(selected.map((request) => request.id), requests.map((request) => request.id));
  assert.notEqual(selected, requests);
});

test('una descarga individual conserva la solicitud aunque esté pendiente', () => {
  const selected = selectProgrammingRequests([requests[1]], {
    includePending: false,
    requestId: requests[1].id
  });
  assert.deepEqual(selected.map((request) => request.id), ['confirmation']);
});

test('el flag includePending se interpreta de forma explícita', () => {
  assert.equal(normalizeProgrammingIncludePending(true, false), true);
  assert.equal(normalizeProgrammingIncludePending('on', false), true);
  assert.equal(normalizeProgrammingIncludePending('false', true), false);
  assert.equal(normalizeProgrammingIncludePending(undefined, false), false);
});

test('el dashboard mantiene el envío flexible y agrega rango y Excel', async () => {
  const view = await readFile(new URL('../src/views/operacionesDashboard.ejs', import.meta.url), 'utf8');
  assert.match(view, /name="fechaDesde"/);
  assert.match(view, /name="fechaHasta"/);
  assert.match(view, /id="includePendingProgramming" type="checkbox"/);
  assert.match(view, /id="programExcelLink"/);
  assert.match(view, /id="sendProgramPdf"/);
  assert.match(view, /id="sendProgramExcel"/);
  assert.match(view, /id="sendProgramWhatsapp">Enviar<\/button>/);
  assert.doesNotMatch(view, /Enviar PDF por WhatsApp/);
  assert.match(view, /JSON\.stringify\(\{fecha:selectedDate,managedBy:currentManager\(\),includePending,formats\}\)/);
  assert.doesNotMatch(view, /if\(!programmingComplete\)/);
});

test('el endpoint conserva incompletas y permite PDF o Excel', async () => {
  const route = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  assert.doesNotMatch(route, /if \(!summary\.isComplete\)/);
  assert.match(route, /normalizeProgrammingIncludePending\(req\.body\?\.includePending, false\)/);
  assert.match(route, /router\.get\('\/programacion\.xlsx'/);
  assert.match(route, /normalizeProgrammingFormats\(req\.body\?\.formats, \['pdf'\]\)/);
  assert.match(route, /formats\.includes\('pdf'\)/);
  assert.match(route, /formats\.includes\('excel'\)/);
  assert.match(route, /selectProgrammingRequests\(loaded\.requests, \{ includePending \}\)/);
});

test('los indicadores cargan y conservan el rango seleccionado', async () => {
  const route = await readFile(new URL('../src/routes/dispatchDashboardMetrics.js', import.meta.url), 'utf8');
  assert.match(route, /function selectedDateRangeFromQuery/);
  assert.match(route, /loadServiceRequestsForRange\(prisma, range\)/);
  assert.match(route, /loadServiceRequestsForDate\(prisma, range\.to\)/);
  assert.match(route, /selectedDate:\s*dateRangeLabel\(range\)/);
});
