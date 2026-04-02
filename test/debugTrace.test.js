import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugTrace, splitFieldDecisions, summarizeError } from '../src/services/debugTrace.js';

test('createDebugTrace starts with secure defaults', () => {
  const trace = createDebugTrace({ phone: '573001112233', currentStepBefore: 'MENU' });
  assert.equal(trace.phone, '573001112233');
  assert.equal(trace.currentStep_before, 'MENU');
  assert.equal(trace.cv_saved, false);
  assert.ok(['disabled', 'fallback'].includes(trace.openai_status));
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
