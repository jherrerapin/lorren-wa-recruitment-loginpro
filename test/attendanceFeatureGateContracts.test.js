import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { filterAttendanceFeatureHtml } from '../src/routes/dispatchBridge.js';

const routeSource = fs.readFileSync(new URL('../src/routes/dispatchBridge.js', import.meta.url), 'utf8');

const sampleHtml = `<!doctype html><html><body><main class="page"><section>Operaciones</section><details class="crud-details attendance-config"><summary>Configurar asistencia</summary><form action="/admin/operaciones/clientes/c1/operaciones/o1/asistencia"><button>Guardar asistencia</button></form></details></main></body></html>`;
const reformattedHtml = `<!doctype html><html><body><main id="operations" data-view="client" class="layout page wide"><details data-module="attendance" class='attendance-config crud-details extra'><summary>Configurar asistencia</summary><form><button>Guardar asistencia</button></form></details></main></body></html>`;
const leafletHtmlWithInvalidIntegrity = `<!doctype html><html><body><main class="page"></main><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9coqIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script></body></html>`;
const attendanceSearchHtml = `<!doctype html><html><body><main class="page"><details class="attendance-config"><form class="attendance-map-form"><input type="checkbox" name="attendanceEnabled" value="true" /></form></details></main><script>fetch(\`https://nominatim.openstreetmap.org/search?\${params.toString()}\`);</script></body></html>`;

test('una persona sin permiso no recibe la configuración de asistencia', () => {
  const output = filterAttendanceFeatureHtml(sampleHtml, { allowed: false });
  assert.doesNotMatch(output, /attendance-config/);
  assert.doesNotMatch(output, /Guardar asistencia/);
});

test('el ocultamiento tolera atributos, comillas y clases reordenadas', () => {
  const output = filterAttendanceFeatureHtml(reformattedHtml, { allowed: false });
  assert.doesNotMatch(output, /attendance-config/);
});

test('una persona autorizada conserva la configuración sin controles globales', () => {
  const output = filterAttendanceFeatureHtml(sampleHtml, { allowed: true });
  assert.match(output, /attendance-config/);
  assert.doesNotMatch(output, /data-attendance-dev-control/);
  assert.doesNotMatch(output, /reclutador-general/);
});

test('el HTML entregado corrige el hash oficial de Leaflet 1.9.4', () => {
  const output = filterAttendanceFeatureHtml(leafletHtmlWithInvalidIntegrity, { allowed: true });
  assert.match(output, /sha256-20nQCchB9co0qIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo=/);
  assert.doesNotMatch(output, /sha256-20nQCchB9coqIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo=/);
});

test('el HTML usa el geocodificador interno y prepara la habilitación al guardar', () => {
  const output = filterAttendanceFeatureHtml(attendanceSearchHtml, { allowed: true });
  assert.match(output, /\/admin\/operaciones\/asistencia\/geocodificar\?\$\{params\.toString\(\)\}/);
  assert.doesNotMatch(output, /nominatim\.openstreetmap\.org\/search/);
  assert.match(output, /name="attendanceEnabled" value="true" checked/);
});

test('panel, geocodificación y configuración exigen el permiso en servidor', () => {
  assert.match(routeSource, /router\.use\(\s*['"]\/asistencia['"]\s*,\s*requireOps\s*,\s*requireAttendanceAccess\s*,\s*dispatchAttendanceAdminRouter\(prisma\)/s);
  assert.match(routeSource, /\/asistencia\/geocodificar[\s\S]*?requireOps[\s\S]*?requireAttendanceAccess[\s\S]*?geocodeAttendanceAddress/);
  assert.match(routeSource, /\/clientes\/:clientId\/operaciones\/:operationId\/asistencia[\s\S]*?requireOps[\s\S]*?requireAttendanceAccess[\s\S]*?dispatchAttendancePointConfigRouter/);
});

test('las activaciones de dispositivos continúan restringidas a DEV', () => {
  assert.match(routeSource, /['"]\/portal-activaciones['"][\s\S]*?requireDev[\s\S]*?dispatchWorkerPortalActivationAdminRouter/);
});

test('se retiró el interruptor global temporal de reclutador-general', () => {
  assert.doesNotMatch(routeSource, /asistencia-acceso\/reclutador-general/);
  assert.doesNotMatch(routeSource, /setRecruiterGeneralAttendanceEnabled/);
  assert.doesNotMatch(routeSource, /attendanceDevControlHtml/);
});

test('el control se carga con denegación segura cuando falla la persistencia', () => {
  assert.match(routeSource, /ATTENDANCE_FEATURE_ACCESS_LOAD_FAILED/);
  assert.match(routeSource, /req\s*\.\s*canAccessAttendanceFeature\s*=\s*false/);
  assert.match(routeSource, /res\s*\.\s*locals\s*\.\s*canAccessAttendanceFeature\s*=\s*false/);
});

test('el wrapper normaliza la firma res.render(view, callback)', () => {
  assert.match(routeSource, /typeof\s+locals\s*===\s*['"]function['"]/);
  assert.match(routeSource, /renderCallback\s*=\s*locals/);
  assert.match(routeSource, /renderLocals\s*=\s*\{\s*\}/);
});
