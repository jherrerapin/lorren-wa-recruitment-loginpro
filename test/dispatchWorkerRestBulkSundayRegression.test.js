import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('descanso remunerado masivo solicita un domingo por cada Directo sin crear otra autoridad backend', async () => {
  const view = await readFile('src/views/operacionesAsignacionesConfirmacion.ejs', 'utf8');
  const route = await readFile('src/routes/dispatchOpsExtras.js', 'utf8');

  assert.match(view, /id="restOriginBatchDialog"/);
  assert.match(view, /id="restOriginBatchList"/);
  assert.match(view, /let restBatchWorkers=\[\]/);
  assert.match(view, /restBatchWorkers\.filter\(\(worker\)=>worker\.contractType==='DIRECTO'\)/);
  assert.match(view, /restBatchWorkers\.length>1/);
  assert.match(view, /data-rest-origin-worker/);
  assert.match(view, /payload\.set\('workerId',worker\.workerId\)/);
  assert.match(view, /payload\.set\('originSundayDate',originSundayDate\)/);
  assert.match(view, /await fetch\(form\.action/);
  assert.match(view, /originDate\.getUTCDay\(\)!==0/);
  assert.match(view, /showToast\(/);
  assert.doesNotMatch(view, /\b(?:window\.)?alert\s*\(/);

  assert.match(route, /router\.post\('\/asignaciones\/descansos'/);
  assert.match(route, /saveWorkerRestAssignment\(prisma/);
  assert.doesNotMatch(route, /originSundayDatesByWorker/);
});
