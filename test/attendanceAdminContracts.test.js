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
  assert.match(adminViewSource, /Jornada manual auditada/);
});

test('la jornada manual del coordinador captura entrada y salida sin una autoridad paralela', () => {
  assert.match(adminViewSource, /type="datetime-local" name="arrivalReportedAt" required/);
  assert.match(adminViewSource, /type="datetime-local" name="departureReportedAt" required/);
  assert.match(adminViewSource, /Registrar jornada manual/);
  assert.match(adminViewSource, /La puntualidad se calcula contra el horario programado/);
  assert.match(adminRouteSource, /arrivalReportedAt: req\.body\.arrivalReportedAt/);
  assert.match(adminRouteSource, /departureReportedAt: req\.body\.departureReportedAt/);
  assert.doesNotMatch(adminViewSource, /<h3>Jornada manual auditada<\/h3><select name="attendanceStatus"/);
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

test('cada auxiliar ocupa una sola fila y entrada, almuerzo y salida quedan visibles sin desplegar la tarjeta', () => {
  assert.match(adminViewSource, /\.attendance-list \{ display: grid; grid-template-columns: 1fr;/);
  assert.match(adminViewSource, /<article class="attendance-card status-card-/);
  assert.match(adminViewSource, /data-visible-attendance-row/);
  assert.doesNotMatch(adminViewSource, /<details class="attendance-card/);
  assert.doesNotMatch(adminViewSource, /id="expandAllAttendance"|id="collapseAllAttendance"|Desplegar todas|Comprimir todas/);
  assert.match(adminViewSource, /<span>Entrada<\/span><strong><%= row\.arrivalReportedLabel \|\| 'Sin registro' %>/);
  assert.match(adminViewSource, /<span>Almuerzo<\/span><strong><%= lunchLabel %>/);
  assert.match(adminViewSource, /<span>Salida<\/span><strong><%= row\.departureReportedLabel \|\| 'Sin registro' %>/);
  assert.match(adminViewSource, /const lunchLabel = row\.breakStarted/);
  assert.match(adminViewSource, /: 'Sin almuerzo';/);
  assert.match(adminViewSource, /Ord\. <%= row\.ordinaryWorkedLabel/);
  assert.match(adminViewSource, /Extra: <%= row\.overtimeLabel/);
});

test('solo ubicación geocerca evidencia y revisión o registro manual conservan interacción plegable', () => {
  assert.match(adminViewSource, /<details data-map-details><summary class="btn">Ver ubicación y geocerca<\/summary>/);
  assert.match(adminViewSource, /const hasAttendanceEvidence = Boolean/);
  assert.match(adminViewSource, /\|\| hasAttendanceEvidence\) \{ %><details data-map-details>/);
  assert.match(adminViewSource, /<details class="review-panel"/);
  assert.match(adminViewSource, /row\.sessionId \? 'Revisar o corregir asistencia' : 'Registrar asistencia manual'/);
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
