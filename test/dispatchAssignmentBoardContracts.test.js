import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('dispatch assignment board view contracts', () => {
  assert.ok(existsSync(new URL('../src/views/operacionesAsignaciones.ejs', import.meta.url)));

  const view = readSource('src/views/operacionesAsignaciones.ejs');
  assert.match(view, /draggable="true"/);
  assert.match(view, /data-worker-id/);
  assert.match(view, /assignmentDropZone/);
  assert.match(view, /name="q"/);
  assert.match(view, /name="operationalCityId"/);
  assert.match(view, /name="vacancyId"/);
  assert.match(view, /name="transportMode"/);
  assert.match(view, /name="locality"/);
  assert.match(view, /name="status"/);
});

test('dispatch bridge routes to visual assignment board and keeps boundaries', () => {
  const bridge = readSource('src/routes/dispatchBridge.js');
  assert.match(bridge, /router\.get\(\s*['"]\/asignaciones['"].*res\.render\(\s*['"]operacionesAsignaciones['"]/s);
  assert.match(bridge, /prisma\.dispatchWorker\.findMany/);

  const webhook = readSource('src/routes/webhook.js');
  assert.doesNotMatch(webhook, /operacionesAsignaciones|assignmentDropZone|dispatch assignment/i);

  const fsm = readSource('src/services/conversationEngine.js');
  assert.doesNotMatch(fsm, /operacionesAsignaciones|assignmentDropZone|dispatch assignment/i);

  const schema = readSource('prisma/schema.prisma');
  assert.doesNotMatch(schema, /operacionesAsignaciones|DispatchAssignment|DispatchOperationRequest/);
  const migrationDirs = readdirSync(new URL('../prisma/migrations', import.meta.url), { withFileTypes: true }).map((entry) => entry.name);
  assert.ok(!migrationDirs.some((name) => /dispatch_assignment_board|operaciones_asignaciones/i.test(name)));
});
