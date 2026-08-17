import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('seleccionar todos opera sobre auxiliares visibles y conserva el flujo existente de descanso', async () => {
  const board = await readFile('src/public/dispatch-assignment-board.js', 'utf8');

  assert.match(board, /function visibleWorkerCards\(\) \{[\s\S]*qsa\('\.worker-card'\)\.filter\(\(card\) => !card\.hidden\)/);
  assert.match(board, /function setVisibleWorkersSelection\(selected\) \{[\s\S]*visibleWorkerCards\(\)\.forEach/);
  assert.match(board, /if \(selected\) selectedWorkerIds\.add\(workerId\);[\s\S]*else selectedWorkerIds\.delete\(workerId\)/);
  assert.match(board, /checkbox\.checked = visibleIds\.length > 0 && selectedVisible === visibleIds\.length/);
  assert.match(board, /checkbox\.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds\.length/);
  assert.match(board, /checkbox\.disabled = visibleIds\.length === 0/);
  assert.match(board, /checkbox\.addEventListener\('change', \(\) => setVisibleWorkersSelection\(checkbox\.checked\)\)/);
  assert.match(board, /checkbox\.id = 'selectAllWorkers'/);
  assert.match(board, /text\.textContent = 'Seleccionar todos'/);

  assert.match(board, /qs\('#clearSelectedWorkers'\)\?\.addEventListener\('click', clearWorkerSelection\)/);
  assert.match(board, /qs\('#restSelectedWorkers'\)\?\.addEventListener\('click', \(\) => openRestDialog\(getSelectedWorkerIds\(\)\)\)/);
  assert.match(board, /qs\('#assignSelectedWorkers'\)\?\.addEventListener\('click', \(\) => \{/);
});

test('el control maestro se sincroniza después de cambios individuales y recargas del tablero', async () => {
  const board = await readFile('src/public/dispatch-assignment-board.js', 'utf8');

  assert.match(board, /function refreshSelectionUi\(\) \{[\s\S]*syncSelectAllUi\(\);\n  \}/);
  assert.match(board, /function setWorkerSelection\(workerId, selected\) \{[\s\S]*refreshSelectionUi\(\);\n  \}/);
  assert.match(board, /function clearWorkerSelection\(\) \{[\s\S]*selectedWorkerIds\.clear\(\);[\s\S]*refreshSelectionUi\(\);/);
  assert.match(board, /selectedWorkerIds\.clear\(\);\n    bindDynamicBoard\(\);/);
  assert.match(board, /function bindStaticBoard\(\) \{\n    ensureSelectAllControl\(\);/);
});
