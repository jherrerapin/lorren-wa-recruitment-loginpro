import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';

const SELECTED_DATE = '2026-07-29';
const SUMMARY_TYPES = ['total', 'pending', 'complete', 'incidents'];

function expectedRenderedUrl(type) {
  return `/admin/operaciones/resumen?fecha=${SELECTED_DATE}&amp;type=${type}`;
}

test('dashboard and summary tabs use the route mounted by dispatchDashboardMetricsRouter', async () => {
  const [dashboardTemplate, summaryTemplate, routeSource, serverSource] = await Promise.all([
    readFile('src/views/operacionesDashboard.ejs', 'utf8'),
    readFile('src/views/operacionesSolicitudesResumen.ejs', 'utf8'),
    readFile('src/routes/dispatchDashboardMetrics.js', 'utf8'),
    readFile('src/server.js', 'utf8')
  ]);

  assert.match(serverSource, /app\.use\('\/admin\/operaciones', wrapAsyncRouter\(dispatchDashboardMetricsRouter\(prisma\)\)\)/);
  assert.match(routeSource, /router\.get\('\/resumen', requireOps/);
  assert.match(routeSource, /router\.get\('\/resumen\/exportar', requireOps/);

  const metrics = {
    totalRequests: 3,
    pendingRequests: 1,
    completedRequests: 2,
    openIncidents: 0
  };

  const dashboardHtml = ejs.render(dashboardTemplate, {
    pageTitle: 'Operaciones / Despacho',
    subtitle: 'Panel operativo',
    role: 'dev',
    selectedDate: SELECTED_DATE,
    metrics,
    canAccessAttendanceFeature: true
  });

  const summaryHtml = ejs.render(summaryTemplate, {
    pageTitle: 'Solicitudes del día',
    subtitle: 'Resumen',
    role: 'dev',
    selectedDate: SELECTED_DATE,
    type: 'total',
    typeLabel: 'Solicitudes del día',
    metrics,
    requests: [],
    message: null,
    activeAssignments: () => [],
    confirmedAssignments: () => [],
    statusLabel: (value) => value,
    assignmentStatusLabel: (value) => value,
    buildHorario: () => '-',
    resolveServiceRequestPolicy: () => ({ canEdit: false, canDelete: false, isTestClient: false })
  });

  for (const type of SUMMARY_TYPES) {
    assert.ok(dashboardHtml.includes(expectedRenderedUrl(type)), `El panel debe enlazar el indicador ${type} a la ruta canónica.`);
    assert.ok(summaryHtml.includes(expectedRenderedUrl(type)), `Las pestañas deben conservar la ruta canónica para ${type}.`);
  }

  assert.match(dashboardHtml, /name="fecha" type="date" value="2026-07-29"/);
  assert.match(dashboardHtml, /formaction="\/admin\/operaciones\/resumen\/exportar">Descargar Excel<\/button>/);
  assert.doesNotMatch(dashboardHtml, /\/admin\/operaciones\/programacion\.xlsx/);

  for (const html of [dashboardHtml, summaryHtml]) {
    assert.doesNotMatch(html, /\/admin\/operaciones\/dispatch\/operations\/summary/);
    assert.doesNotMatch(html, /\/admin\/operaciones\/solicitudes\/resumen/);
    assert.doesNotMatch(html, /(?:\?|&amp;)tipo=/);
  }
});

test('novedades usa el resumen canónico, una sola búsqueda por fecha y conserva la fecha al abrir asignación', async () => {
  const noveltyTemplate = await readFile('src/views/operacionesNovedades.ejs', 'utf8');
  const html = ejs.render(noveltyTemplate, {
    pageTitle: 'Novedades operativas',
    role: 'dev',
    selectedDate: SELECTED_DATE,
    status: 'OPEN',
    incidents: [{
      id: 'TEST-INCIDENT-1260',
      type: 'RETRASO',
      status: 'OPEN',
      description: 'Novedad operativa de prueba.',
      reportedBy: 'Coordinación prueba',
      createdByUsername: 'TEST-USER',
      resolutionNote: null,
      worker: null,
      assignment: null,
      serviceRequest: {
        id: 'TEST-REQUEST-1260',
        clientName: 'Cliente Prueba',
        operationPointName: 'Operación Prueba',
        cityName: 'Ciudad Prueba',
        serviceDate: new Date('2026-07-29T05:00:00.000Z'),
        startTime: '07:00',
        endTime: '15:00'
      }
    }]
  });

  assert.match(html, /action="\/admin\/operaciones\/resumen"/);
  assert.match(html, /name="type" value="total"/);
  assert.match(html, /Buscar solicitudes para reportar novedad/);
  assert.doesNotMatch(html, /Ver solicitudes de la fecha seleccionada/);
  assert.ok(html.includes(expectedRenderedUrl('total')));
  assert.ok(html.includes(`/admin/operaciones/asignaciones?serviceRequestId=TEST-REQUEST-1260&amp;fecha=${SELECTED_DATE}`));
  assert.match(html, /Cierra solo el seguimiento de esta novedad\. No modifica la solicitud ni sus asignaciones\./);
  assert.doesNotMatch(html, /\/admin\/operaciones\/solicitudes\/resumen/);
  assert.doesNotMatch(html, /(?:\?|&amp;)tipo=/);
});
