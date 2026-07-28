import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridgeSource = fs.readFileSync(new URL('../src/routes/dispatchBridge.js', import.meta.url), 'utf8');
const adminRouteSource = fs.readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
const dashboardRouteSource = fs.readFileSync(new URL('../src/routes/dispatchDashboardMetrics.js', import.meta.url), 'utf8');
const dashboardSource = fs.readFileSync(new URL('../src/views/operacionesDashboard.ejs', import.meta.url), 'utf8');
const adminViewSource = fs.readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');

test('el panel administrativo se monta detrás de permisos operativos y del feature gate', () => {
  assert.match(bridgeSource, /router\.use\(\s*['"]\/asistencia['"]\s*,\s*requireOps\s*,\s*requireAttendanceAccess\s*,\s*dispatchAttendanceAdminRouter\(prisma\)/s);
});

test('la geocodificación se registra antes del router general de asistencia', () => {
  const geocodingIndex = bridgeSource.indexOf("'/asistencia/geocodificar'");
  const adminIndex = bridgeSource.indexOf("'/asistencia',\n    requireOps");
  assert.ok(geocodingIndex >= 0);
  assert.ok(adminIndex > geocodingIndex);
});

test('las decisiones administrativas recalculan jornada y exigen motivo auditable', () => {
  assert.match(adminRouteSource, /reviewAttendanceWorkdaySession/);
  assert.match(adminRouteSource, /recognizeEarlyArrival/);
  assert.match(adminRouteSource, /registerManualAttendance/);
  assert.match(adminViewSource, /name="reason" minlength="5"/);
  assert.match(adminViewSource, /Rechazar marcación/);
  assert.match(adminViewSource, /Reabrir revisión/);
  assert.match(adminViewSource, /Marcación manual auditada/);
});

test('la evidencia se entrega mediante URL firmada y ruta protegida', () => {
  assert.match(adminRouteSource, /getSignedDownloadUrl/);
  assert.match(adminRouteSource, /validAttendanceEvidenceKey/);
  assert.match(adminRouteSource, /arrival\|departure/);
  assert.match(adminViewSource, /\/admin\/operaciones\/asistencia\/evidence\//);
});

test('el dashboard resuelve la misma autoridad antes de mostrar asistencia', () => {
  assert.match(dashboardRouteSource, /resolveAttendanceFeatureAccess/);
  assert.match(dashboardRouteSource, /loadAttendanceAccessForDashboard/);
  assert.match(dashboardRouteSource, /canAccessAttendanceFeature: Boolean\(attendanceAccess\?\.allowed\)/);
  assert.match(dashboardSource, /canAccessAttendanceFeature/);
  assert.match(dashboardSource, /href="\/admin\/operaciones\/asistencia"/);
});

test('las tarjetas comprimidas muestran llegada, almuerzo, salida y horas extra', () => {
  assert.match(adminViewSource, /<details class="attendance-card status-card-/);
  assert.match(adminViewSource, /Desplegar todas/);
  assert.match(adminViewSource, /Comprimir todas/);
  assert.match(adminViewSource, /<span>Llegada<\/span>/);
  assert.match(adminViewSource, /<span>Almuerzo<\/span>/);
  assert.match(adminViewSource, /<span>Salida<\/span>/);
  assert.match(adminViewSource, /<span>Horas extra<\/span>/);
  assert.match(adminViewSource, /Riesgo: <%= row\.riskScore %>\/100/);
});

test('el detalle muestra desglose ordinario, extra, penalización, fotografías y geocerca', () => {
  assert.match(adminViewSource, /Ver ubicación y geocerca/);
  assert.match(adminViewSource, /Entrada a salida/);
  assert.match(adminViewSource, /Inicio contabilizado/);
  assert.match(adminViewSource, /Anticipado excluido/);
  assert.match(adminViewSource, /Almuerzo descontado/);
  assert.match(adminViewSource, /Horas ordinarias/);
  assert.match(adminViewSource, /Horas extra/);
  assert.match(adminViewSource, /Total trabajado/);
  assert.match(adminViewSource, /1 h 30 min/);
  assert.match(adminViewSource, /Ver fotografía de entrada/);
  assert.match(adminViewSource, /Ver fotografía de salida/);
  assert.match(adminViewSource, /leaflet@1\.9\.4/);
});

test('el coordinador puede reconocer tiempo anticipado con auditoría', () => {
  assert.match(adminViewSource, /name="recognizeEarlyArrival" value="true"/);
  assert.match(adminViewSource, /Reconocer tiempo anterior al turno/);
  assert.match(adminViewSource, /Esta decisión queda auditada/);
});

test('los filtros se normalizan antes de insertarse como atributos ocultos', () => {
  assert.match(adminRouteSource, /safeHtmlAttributeState/);
  assert.match(adminRouteSource, /sanitizeBoardFilterState/);
  assert.match(adminRouteSource, /replace\(\/\[&<>"'`\]\//);
});