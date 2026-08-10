import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('un auxiliar ya asignado muestra advertencia antes del formulario de descanso', async () => {
  const view = await read('src/views/operacionesAsignacionesConfirmacion.ejs');
  assert.match(view, /data-same-day-assignment="<%= hasSameDayAssignment \? 'true' : 'false' %>"/);
  assert.match(view, /id="restConflictDialog"/);
  assert.match(view, /id="restConflictMessage"/);
  assert.match(view, /id="confirmAssignedRest">Dar descanso<\/button>/);
  assert.match(view, /name="allowAssignedRest" id="allowAssignedRestInput" value="false"/);
  assert.match(view, /const assignedWorkers=restBatchWorkers\.filter\(\(worker\)=>worker\.sameDayAssignment\)/);
  assert.match(view, /qs\('#restConflictDialog'\)\?\.showModal\(\);\s*return;\s*}\s*dialog\?\.showModal\(\);/);
  assert.match(view, /allowAssignedRestInput\.value='true';qs\('#restAssignmentDialog'\)\?\.showModal\(\)/);
  assert.match(view, /payload\.set\('allowAssignedRest','true'\)/);
  assert.ok(view.indexOf('id="restConflictDialog"') < view.indexOf('id="restAssignmentDialog"'));
});

test('el motivo sigue siendo condicional al tipo de contrato', async () => {
  const view = await read('src/views/operacionesAsignacionesConfirmacion.ejs');
  assert.match(view, /if\(reasonField\)reasonField\.hidden=!direct/);
  assert.match(view, /if\(reasonInput\)\{reasonInput\.disabled=!direct;reasonInput\.required=direct/);
});
