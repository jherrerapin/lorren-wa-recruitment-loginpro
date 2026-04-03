import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTechnicalOutboundCandidateUpdate } from '../src/services/adminOutboundPolicy.js';

test('outbound técnico/dev solo actualiza lastOutboundAt y no CONTACTADO', () => {
  const now = new Date('2026-04-03T10:00:00Z');
  const before = { status: 'REGISTRADO', lastOutboundAt: null };
  const update = buildTechnicalOutboundCandidateUpdate(now);
  const after = { ...before, ...update };

  assert.equal(after.status, 'REGISTRADO');
  assert.equal(after.lastOutboundAt.toISOString(), '2026-04-03T10:00:00.000Z');
  assert.equal(Object.hasOwn(update, 'status'), false);
});
