import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridgeSource = fs.readFileSync(
  new URL('../src/routes/dispatchBridge.js', import.meta.url),
  'utf8'
);
const adminRouteSource = fs.readFileSync(
  new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url),
  'utf8'
);
const dashboardRouteSource = fs.readFileSync(
  new URL('../src/routes/dispatchDashboardMetrics.js', import.meta.url),
  'utf8'
);
const dashboardSource = fs.readFileSync(
  new URL('../src/views/operacionesDashboard.ejs', import.meta.url),
  'utf8'
);
const adminViewSource = fs.readFileSync(
  new URL('../src/views/operacionesAsistencia.ejs', import.meta.url),
  'utf8'
);

test('el panel administrativo se monta detrás de permisos operativos y del feature gate', () => {
  assert.match(
    bridgeSource,
    /router\.use\(\s*['"]\/asistencia['"]\s*,\s*requireOps\s*,\s*requireAttendanceAccess\s*,\s*dispatchAttendanceAdminRouter\(prisma\)/s
  );
});

test('la geocodificación específica se registra antes del router general de asistencia', () => {
  const geocodingIndex = bridgeSource.indexOf("'/asistencia/geocodificar'");
  const adminIndex = bridgeSource.indexOf("'/asistencia',\n    requireOps");
  assert.ok(geocodingIndex >= 0);
  assert.ok(adminIndex > geocodingIndex);
});

test('las decisiones administrativas exigen motivo y crean auditoría', () => {
  assert.match(adminRouteSource, /reviewAttendanceSession/);
  assert.match(adminRouteSource, /registerManualAttendance/);
  assert.match(adminViewSource, /name="reason" minlength="5"/);
  assert.match(adminViewSource, /Rechazar marcación/);
  assert.match(adminViewSource, /Reabrir revisión/);
  assert.match(adminViewSource, /Marcación manual auditada/);
});

test('la evidencia se entrega mediante URL firmada y ruta protegida', () => {
  assert.match(adminRouteSource, /getSignedDownloadUrl/);
  assert.match(adminRouteSource, /validAttendanceEvidenceKey/);
  assert.match(adminRouteSource, /router\.get\(['"]\/evidence\/:markId['"]/);
  assert.match(adminViewSource, /\/admin\/operaciones\/asistencia\/evidence\//);
});

test('el dashboard resuelve la misma autoridad antes de mostrar el acceso a asistencia', () => {
  assert.match(dashboardRouteSource, /resolveAttendanceFeatureAccess/);
  assert.match(dashboardRouteSource, /loadAttendanceAccessForDashboard/);
  assert.match(dashboardRouteSource, /canAccessAttendanceFeature: Boolean\(attendanceAccess\?\.allowed\)/);
  assert.match(dashboardSource, /canAccessAttendanceFeature/);
  assert.match(dashboardSource, /href="\/admin\/operaciones\/asistencia"/);
});

test('las tarjetas de auxiliares se comprimen con información operativa esencial', () => {
  assert.match(adminViewSource, /<details class="attendance-card status-card-/);
  assert.match(adminViewSource, /<summary class="attendance-summary">/);
  assert.match(adminViewSource, /Desplegar todas/);
  assert.match(adminViewSource, /Comprimir todas/);
  assert.match(adminViewSource, /<span>Llegada<\/span>/);
  assert.match(adminViewSource, /<span>Puntualidad<\/span>/);
  assert.match(adminViewSource, /<span>Distancia<\/span>/);
  assert.match(adminViewSource, /<span>Precisión GPS<\/span>/);
  assert.match(adminViewSource, /Riesgo: <%= row\.riskScore %>\/100/);
  assert.match(adminViewSource, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(adminViewSource, /details\.attendance-card\[open\] \{ grid-column: 1 \/ -1/);
});

test('el panel conserva mapa, geocerca, precisión, riesgo y fotografía dentro del detalle', () => {
  assert.match(adminViewSource, /Ver ubicación y geocerca/);
  assert.match(adminViewSource, /Precisión GPS/);
  assert.match(adminViewSource, /Riesgo:/);
  assert.match(adminViewSource, /Ver fotografía/);
  assert.match(adminViewSource, /leaflet@1\.9\.4/);
});