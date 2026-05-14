import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManualInterventionCandidateUpdate, buildTechnicalOutboundCandidateUpdate } from '../src/services/adminOutboundPolicy.js';

test('outbound técnico/dev solo actualiza lastOutboundAt y no CONTACTADO', () => {
  const now = new Date('2026-04-03T10:00:00Z');
  const before = { status: 'REGISTRADO', lastOutboundAt: null };
  const update = buildTechnicalOutboundCandidateUpdate(now);
  const after = { ...before, ...update };

  assert.equal(after.status, 'REGISTRADO');
  assert.equal(after.lastOutboundAt.toISOString(), '2026-04-03T10:00:00.000Z');
  assert.equal(Object.hasOwn(update, 'status'), false);
});


test('outbound manual/dashboard pausa el bot para la conversación', () => {
  const now = new Date('2026-04-03T10:00:00Z');
  const update = buildManualInterventionCandidateUpdate({
    now,
    pausedBy: 'dev',
    reason: 'Conversacion tomada manualmente desde dashboard'
  });

  assert.equal(update.botPaused, true);
  assert.equal(update.botPausedAt.toISOString(), '2026-04-03T10:00:00.000Z');
  assert.equal(update.botPausedBy, 'dev');
  assert.equal(update.botPauseReason, 'Conversacion tomada manualmente desde dashboard');
  assert.equal(update.botResumeMode, 'manual_resume_dashboard');
  assert.equal(update.lastOutboundAt.toISOString(), '2026-04-03T10:00:00.000Z');
  assert.equal(update.reminderState, 'CANCELLED');
});
