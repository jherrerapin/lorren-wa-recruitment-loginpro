import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugTrace, splitFieldDecisions, summarizeError } from '../src/services/debugTrace.js';

test('createDebugTrace starts with secure defaults', () => {
  const trace = createDebugTrace({ phone: '573001112233', currentStepBefore: 'MENU' });
  assert.equal(trace.phone, '573001112233');
  assert.equal(trace.currentStep_before, 'MENU');
  assert.equal(trace.cv_saved, false);
  assert.equal(trace.batched_message_count, 1);
  assert.equal(trace.used_multiline_context, false);
  assert.ok(['disabled', 'fallback'].includes(trace.openai_status));
  assert.equal(typeof trace.openai_model, 'string');
  assert.equal(typeof trace.openai_temperature_omitted, 'boolean');
  assert.equal(Object.hasOwn(trace, 'suspicious_full_name_rejected'), false);
  assert.equal(Object.hasOwn(trace, 'rejected_name_reason'), false);
});

test('splitFieldDecisions persiste datos ya curados y protege valores existentes', () => {
  const parsed = { fullName: 'Carlos Madrid', age: 24, neighborhood: 'Centro' };
  const candidate = { fullName: null, age: null, neighborhood: 'Modelia' };
  const decisions = splitFieldDecisions(parsed, candidate);

  assert.deepEqual(decisions.persistedFields, ['fullName', 'age']);
  assert.equal(decisions.persistedData.fullName, 'Carlos Madrid');
  assert.ok(decisions.rejectedFields.includes('neighborhood'));
});

test('persistencia no interpreta palabras del nombre como ciudad, cargo o intención', () => {
  for (const fullName of ['Carlos Madrid', 'Andrés Salado', 'Auxilio Lara']) {
    const decisions = splitFieldDecisions({ fullName }, { fullName: null });
    assert.equal(decisions.persistedData.fullName, fullName);
    assert.deepEqual(decisions.rejectedFields, []);
  }
});

test('persistencia evita alias exacto entre nombre y residencia', () => {
  const decisions = splitFieldDecisions(
    { fullName: 'Carlos Madrid', neighborhood: 'Carlos Madrid' },
    { fullName: null, neighborhood: null }
  );

  assert.equal(decisions.persistedData.fullName, 'Carlos Madrid');
  assert.equal(decisions.persistedData.neighborhood, undefined);
  assert.deepEqual(decisions.rejectedFields, ['neighborhood']);
});

test('summarizeError does not leak nested payloads', () => {
  const summary = summarizeError({ name: 'AxiosError', message: 'Boom', response: { status: 500, data: { token: 'secret' } } });
  assert.match(summary, /AxiosError/);
  assert.match(summary, /HTTP 500/);
  assert.doesNotMatch(summary, /secret/);
});

test('permite sobrescritura explícita de transporte en corrección', () => {
  const decisions = splitFieldDecisions(
    { transportMode: 'Moto' },
    { transportMode: 'Publico' },
    { allowOverwriteFields: ['transportMode'] }
  );
  assert.deepEqual(decisions.persistedFields, ['transportMode']);
  assert.equal(decisions.persistedData.transportMode, 'Moto');
});
