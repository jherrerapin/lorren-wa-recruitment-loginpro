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

test('la ruta de escritura exige permiso de asistencia en servidor', () => {
  assert.match(
    routeSource,
    /\/clientes\/:clientId\/operaciones\/:operationId\/asistencia[\s\S]*?requireOps[\s\S]*?requireAttendanceAccess[\s\S]*?dispatchAttendancePointConfigRouter/
  );
});

test('el interruptor exige DEV y valores booleanos explicitos', () => {
  assert.match(
    routeSource,
    /\/asistencia-acceso\/reclutador-general[\s\S]*?requireDev/
  );
  assert.match(routeSource, /\['true', 'false'\]\.includes\(enabled\)/);
});

test('el control se carga con denegacion segura cuando falla la persistencia', () => {
  assert.match(routeSource, /ATTENDANCE_FEATURE_ACCESS_LOAD_FAILED/);
  assert.match(routeSource, /req\.canAccessAttendanceFeature = false/);
  assert.match(routeSource, /res\.locals\.canAccessAttendanceFeature = false/);
});
