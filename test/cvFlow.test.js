import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_CV_EXTENSIONS,
  hasAllowedCvExtension,
  isCvMimeTypeAllowed,
  resolveStepAfterDataCompletion,
  shouldFinalizeAfterCv
} from '../src/services/cvFlow.js';

test('datos completos sin CV pasan a ASK_CV y no a DONE', () => {
  const step = resolveStepAfterDataCompletion({ hasCv: false });
  assert.equal(step, 'ASK_CV');
  assert.notEqual(step, 'DONE');
});

test('el contrato de carga permite PDF, DOC y DOCX con MIME coherente', () => {
  assert.deepEqual(ALLOWED_CV_EXTENSIONS, ['.pdf', '.doc', '.docx']);
  assert.equal(hasAllowedCvExtension('hv.pdf'), true);
  assert.equal(hasAllowedCvExtension('hv.doc'), true);
  assert.equal(hasAllowedCvExtension('hv.docx'), true);

  assert.equal(isCvMimeTypeAllowed('application/pdf', 'hv.pdf'), true);
  assert.equal(isCvMimeTypeAllowed('application/msword', 'hv.doc'), true);
  assert.equal(isCvMimeTypeAllowed('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'hv.docx'), true);
  assert.equal(isCvMimeTypeAllowed('application/octet-stream', 'hv.pdf'), true);
  assert.equal(isCvMimeTypeAllowed('application/octet-stream', 'hv.doc'), true);
  assert.equal(isCvMimeTypeAllowed('application/octet-stream', 'hv.docx'), true);
  assert.equal(isCvMimeTypeAllowed('', 'hv.doc'), true);

  assert.equal(isCvMimeTypeAllowed('application/pdf', 'hv.doc'), false);
  assert.equal(isCvMimeTypeAllowed('application/msword', 'hv.docx'), false);
  assert.equal(isCvMimeTypeAllowed('application/pdf', 'hv.exe'), false);
  assert.equal(isCvMimeTypeAllowed('image/jpeg', 'hv.jpg'), false);
});

test('con CV recibido y sin campos faltantes sí se cierra en DONE', () => {
  assert.equal(shouldFinalizeAfterCv({ missingFields: [] }), true);
  assert.equal(resolveStepAfterDataCompletion({ hasCv: true }), 'DONE');
});

test('sin CV válido no hay cierre final', () => {
  assert.equal(shouldFinalizeAfterCv({ missingFields: ['edad'] }), false);
  assert.equal(resolveStepAfterDataCompletion({ hasCv: false }), 'ASK_CV');
});
