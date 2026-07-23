import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { filterAttendanceFeatureHtml } from '../src/routes/dispatchBridge.js';

const routeSource = fs.readFileSync(
  new URL('../src/routes/dispatchBridge.js', import.meta.url),
  'utf8'
);

const sampleHtml = `<!doctype html>
<html>
<body>
<main class="page">
  <section>Operaciones</section>
  <details class="crud-details attendance-config">
    <summary>Configurar asistencia</summary>
    <form action="/admin/operaciones/clientes/c1/operaciones/o1/asistencia">
      <button>Guardar asistencia</button>
    </form>
  </details>
</main>
</body>
</html>`;

const reformattedHtml = `<!doctype html>
<html>
<body>
<main id="operations" data-view="client" class="layout page wide">
  <section>Operaciones</section>
  <details data-module="attendance" class='attendance-config crud-details extra'>
    <summary>Configurar asistencia</summary>
    <form><button>Guardar asistencia</button></form>
  </details>
</main>
</body>
</html>`;

const leafletHtmlWithInvalidIntegrity = `<!doctype html>
<html>
<body>
<main class="page"></main>
<script
  src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9coqIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
  crossorigin=""
></script>
</body>
</html>`;

const attendanceSearchHtml = `<!doctype html>
<html>
<body>
<main class="page">
  <details class="attendance-config">
    <form class="attendance-map-form">
      <input type="checkbox" name="attendanceEnabled" value="true" />
    </form>
  </details>
</main>
<script>
  fetch(\`https://nominatim.openstreetmap.org/search?\${params.toString()}\`);
</script>
</body>
</html>`;

test('una persona sin acceso no ve la configuracion de asistencia', () => {
  const output = filterAttendanceFeatureHtml(sampleHtml, {
    allowed: false,
    isDev: false,
    recruiterGeneralEnabled: false
  });

  assert.doesNotMatch(output, /attendance-config/);
  assert.doesNotMatch(output, /Guardar asistencia/);
  assert.doesNotMatch(output, /data-attendance-dev-control/);
});

test('el ocultamiento tolera atributos, comillas y clases reordenadas', () => {
  const output = filterAttendanceFeatureHtml(reformattedHtml, {
    allowed: false,
    isDev: false,
    recruiterGeneralEnabled: false
  });

  assert.doesNotMatch(output, /attendance-config/);
  assert.doesNotMatch(output, /Guardar asistencia/);
});

test('dev conserva la configuracion y recibe el boton de activacion', () => {
  const output = filterAttendanceFeatureHtml(sampleHtml, {
    allowed: true,
    isDev: true,
    recruiterGeneralEnabled: false
  });

  assert.match(output, /attendance-config/);
  assert.match(output, /data-attendance-dev-control/);
  assert.match(output, /Activar para reclutador-general/);
  assert.match(output, /name="enabled" value="true"/);
});

test('el control DEV se inserta aunque main tenga otros atributos o clases', () => {
  const output = filterAttendanceFeatureHtml(reformattedHtml, {
    allowed: true,
    isDev: true,
    recruiterGeneralEnabled: false
  });

  assert.match(output, /data-attendance-dev-control/);
  assert.match(output, /layout page wide/);
});

test('dev recibe boton de desactivacion cuando el acceso ya esta habilitado', () => {
  const output = filterAttendanceFeatureHtml(sampleHtml, {
    allowed: true,
    isDev: true,
    recruiterGeneralEnabled: true
  });

  assert.match(output, /Desactivar para reclutador-general/);
  assert.match(output, /name="enabled" value="false"/);
});

test('reclutador-general habilitado ve la funcion pero nunca el control DEV', () => {
  const output = filterAttendanceFeatureHtml(sampleHtml, {
    allowed: true,
    isDev: false,
    recruiterGeneralEnabled: true
  });

  assert.match(output, /attendance-config/);
  assert.doesNotMatch(output, /data-attendance-dev-control/);
});

test('el filtro no duplica el control DEV', () => {
  const first = filterAttendanceFeatureHtml(sampleHtml, {
    allowed: true,
    isDev: true,
    recruiterGeneralEnabled: false
  });
  const second = filterAttendanceFeatureHtml(first, {
    allowed: true,
    isDev: true,
    recruiterGeneralEnabled: false
  });

  assert.equal((second.match(/data-attendance-dev-control/g) || []).length, 1);
});

test('el HTML entregado corrige el hash oficial de Leaflet 1.9.4', () => {
  const output = filterAttendanceFeatureHtml(leafletHtmlWithInvalidIntegrity, {
    allowed: true,
    isDev: false,
    recruiterGeneralEnabled: false
  });

  assert.match(output, /sha256-20nQCchB9co0qIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo=/);
  assert.doesNotMatch(output, /sha256-20nQCchB9coqIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo=/);
});

test('el HTML usa el geocodificador interno y prepara la habilitación al guardar', () => {
  const output = filterAttendanceFeatureHtml(attendanceSearchHtml, {
    allowed: true,
    isDev: false,
    recruiterGeneralEnabled: true
  });

  assert.match(output, /\/admin\/operaciones\/asistencia\/geocodificar\?\$\{params\.toString\(\)\}/);
  assert.doesNotMatch(output, /nominatim\.openstreetmap\.org\/search/);
  assert.match(output, /name="attendanceEnabled" value="true" checked/);
});

test('la ruta de escritura exige permiso de asistencia en servidor', () => {
  assert.match(
    routeSource,
    /\/clientes\/:clientId\/operaciones\/:operationId\/asistencia[\s\S]*?requireOps[\s\S]*?requireAttendanceAccess[\s\S]*?dispatchAttendancePointConfigRouter/
  );
});

test('la búsqueda interna exige sesión de operaciones y permiso de asistencia', () => {
  assert.match(
    routeSource,
    /\/asistencia\/geocodificar[\s\S]*?requireOps[\s\S]*?requireAttendanceAccess[\s\S]*?geocodeAttendanceAddress/
  );
});

test('el interruptor exige DEV y valores booleanos explicitos', () => {
  assert.match(
    routeSource,
    /\/asistencia-acceso\/reclutador-general[\s\S]*?requireDev/
  );
  assert.match(
    routeSource,
    /\[\s*['"]true['"]\s*,\s*['"]false['"]\s*\]\s*\.\s*includes\(\s*enabled\s*\)/
  );
});

test('el control se carga con denegacion segura cuando falla la persistencia', () => {
  assert.match(routeSource, /ATTENDANCE_FEATURE_ACCESS_LOAD_FAILED/);
  assert.match(routeSource, /req\s*\.\s*canAccessAttendanceFeature\s*=\s*false/);
  assert.match(routeSource, /res\s*\.\s*locals\s*\.\s*canAccessAttendanceFeature\s*=\s*false/);
});

test('el wrapper normaliza la firma res.render(view, callback)', () => {
  assert.match(routeSource, /typeof\s+locals\s*===\s*['"]function['"]/);
  assert.match(routeSource, /renderCallback\s*=\s*locals/);
  assert.match(routeSource, /renderLocals\s*=\s*\{\s*\}/);
});
