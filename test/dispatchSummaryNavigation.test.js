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

  for (const html of [dashboardHtml, summaryHtml]) {
    assert.doesNotMatch(html, /\/admin\/operaciones\/dispatch\/operations\/summary/);
    assert.doesNotMatch(html, /\/admin\/operaciones\/solicitudes\/resumen/);
    assert.doesNotMatch(html, /(?:\?|&amp;)tipo=/);
  }
});
