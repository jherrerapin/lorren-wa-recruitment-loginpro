import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugTrace, isSuspiciousFullName, splitFieldDecisions, summarizeError } from '../src/services/debugTrace.js';

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
});

test('splitFieldDecisions persists only empty candidate fields and rejects suspicious name', () => {
  const parsed = { fullName: 'Juan 123', age: 24, neighborhood: 'Centro' };
  const candidate = { age: null, neighborhood: 'Modelia' };
  const decisions = splitFieldDecisions(parsed, candidate);
  assert.deepEqual(decisions.persistedFields, ['age']);
  assert.equal(decisions.suspiciousFullNameRejected, true);
  assert.ok(decisions.rejectedFields.includes('fullName'));
  assert.ok(decisions.rejectedFields.includes('neighborhood'));
});

test('summarizeError does not leak nested payloads', () => {
  const summary = summarizeError({ name: 'AxiosError', message: 'Boom', response: { status: 500, data: { token: 'secret' } } });
  assert.match(summary, /AxiosError/);
  assert.match(summary, /HTTP 500/);
  assert.doesNotMatch(summary, /secret/);
});

test('isSuspiciousFullName rejects intention/question phrases as names', () => {
  assert.equal(isSuspiciousFullName('me interesa'), true);
  assert.equal(isSuspiciousFullName('si estoy interesado'), true);
  assert.equal(isSuspiciousFullName('quiero continuar'), true);
  assert.equal(isSuspiciousFullName('qué datos necesitas'), true);
  assert.equal(isSuspiciousFullName('tengo moto'), true);
  assert.equal(isSuspiciousFullName('poseo vehículo'), true);
  assert.equal(isSuspiciousFullName('ok'), true);
});

test('isSuspiciousFullName keeps real names valid', () => {
  assert.equal(isSuspiciousFullName('Carlos Lara'), false);
  assert.equal(isSuspiciousFullName('Me llamo Carlos Lara'), true);
  const decisions = splitFieldDecisions({ fullName: 'Carlos Lara' }, { fullName: null });
  assert.deepEqual(decisions.persistedFields, ['fullName']);
});

test('permite sobrescritura explícita de transporte en corrección', () => {
  const decisions = splitFieldDecisions(
    { transportMode: 'Moto' },
    { transportMode: 'Sin medio de transporte' },
    { allowOverwriteFields: ['transportMode'] }
  );
  assert.deepEqual(decisions.persistedFields, ['transportMode']);
  assert.equal(decisions.persistedData.transportMode, 'Moto');
});
