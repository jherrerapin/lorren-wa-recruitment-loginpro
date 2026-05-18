import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
const route = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
const view = fs.readFileSync('src/views/operacionesAsignaciones.ejs', 'utf8');

test('dispatch persistence contracts', () => {
  assert.match(schema, /model DispatchServiceRequest/);
  assert.match(schema, /model DispatchAssignment/);
  assert.match(schema, /assignments\s+DispatchAssignment\[\]/);

  const migrations = fs.readdirSync('prisma/migrations');
  assert.ok(migrations.some((m) => m.includes('add_dispatch_service_requests_assignments')));

  assert.match(route, /post\('\/asignaciones\/solicitudes'/);
  assert.match(route, /post\('\/asignaciones\/assign'/);
  assert.match(route, /post\('\/asignaciones\/unassign'/);

  assert.match(view, /serviceRequestId/);
  assert.match(view, /assignmentDropZone/);
  assert.match(view, /\/admin\/operaciones\/asignaciones\/assign/);
  assert.match(view, /\/admin\/operaciones\/asignaciones\/unassign/);
  assert.match(view, /draggable="true"/);

  assert.doesNotMatch(route, /webhook/i);
  assert.doesNotMatch(route, /conversationEngine|FSM/i);
});
