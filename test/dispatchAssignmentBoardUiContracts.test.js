import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('operacionesAsignaciones ui board contracts', () => {
  const view = readSource('src/views/operacionesAsignacionesConfirmacion.ejs');
  const legacyView = readSource('src/views/operacionesAsignaciones.ejs');
  assert.match(legacyView, /include\('operacionesAsignacionesConfirmacion'/);
  assert.match(view, /board-layout/);
  assert.match(view, /Auxiliares disponibles/);
  assert.match(view, /Solicitudes de servicio/);
  assert.match(view, /<h2>Asignación<\/h2>/);
  assert.match(view, /assignmentDropZone/);
  assert.match(view, /draggable="true"/);
  assert.match(view, /data-worker-id/);
  assert.match(view, /\/admin\/operaciones\/asignaciones\/assign/);
  assert.match(view, /\/admin\/operaciones\/asignaciones\/unassign/);
  assert.match(view, /if \(role === 'dev'\)/);
});

test('assignment board ui does not alter forbidden scopes', () => {
  const schema = readSource('prisma/schema.prisma');
  assert.doesNotMatch(schema, /operacionesAsignaciones|assignment-board-ui/i);

  const migrations = readdirSync(new URL('../prisma/migrations', import.meta.url), { withFileTypes: true })
    .map((entry) => entry.name);
  assert.ok(!migrations.some((name) => /assignment_board_ui|dispatch_assignment_board_ui/i.test(name)));

  const webhook = readSource('src/routes/webhook.js');
  assert.doesNotMatch(webhook, /assignment-board-ui|operacionesAsignaciones ui/i);

  const conversationEngine = readSource('src/services/conversationEngine.js');
  assert.doesNotMatch(conversationEngine, /assignment-board-ui|operacionesAsignaciones ui/i);
});
