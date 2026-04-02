import test from 'node:test';
import assert from 'node:assert/strict';
import { isCvMimeTypeAllowed, resolveStepAfterDataCompletion, shouldFinalizeAfterCv } from '../src/services/cvFlow.js';

test('datos completos sin CV pasan a ASK_CV y no a DONE', () => {
  const step = resolveStepAfterDataCompletion({ hasCv: false });
  assert.equal(step, 'ASK_CV');
  assert.notEqual(step, 'DONE');
});

test('en ASK_CV solo se permite cierre con CV válido', () => {
  assert.equal(isCvMimeTypeAllowed('application/pdf'), true);
  assert.equal(isCvMimeTypeAllowed('application/msword'), true);
  assert.equal(isCvMimeTypeAllowed('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
  assert.equal(isCvMimeTypeAllowed('image/jpeg'), false);
});

test('con CV recibido y sin campos faltantes sí se cierra en DONE', () => {
  assert.equal(shouldFinalizeAfterCv({ missingFields: [] }), true);
  assert.equal(resolveStepAfterDataCompletion({ hasCv: true }), 'DONE');
});

test('sin CV válido no hay cierre final', () => {
  assert.equal(shouldFinalizeAfterCv({ missingFields: ['edad'] }), false);
  assert.equal(resolveStepAfterDataCompletion({ hasCv: false }), 'ASK_CV');
});
