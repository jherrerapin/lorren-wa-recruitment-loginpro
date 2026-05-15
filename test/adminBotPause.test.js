import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInboundResumeUpdate, describeResumeBehavior, shouldBlockAutomation, shouldResumeAutomationOnInbound } from '../src/services/botAutomationPolicy.js';

test('si botPaused=true se bloquea automatización', () => {
  assert.equal(shouldBlockAutomation({ botPaused: true }), true);
  assert.equal(shouldBlockAutomation({ botPaused: false }), false);
});

test('al reanudar con contexto pendiente queda explícito que requiere trigger posterior', () => {
  const behavior = describeResumeBehavior({ pendingInboundCount: 2, supportsImmediateReplay: false });
  assert.equal(behavior.hasPendingContext, true);
  assert.equal(behavior.requiresTrigger, true);
  assert.equal(behavior.resumeMode, 'awaiting_inbound_trigger_with_pending_context');
});

test('al reanudar sin pendientes no requiere trigger', () => {
  const behavior = describeResumeBehavior({ pendingInboundCount: 0, supportsImmediateReplay: false });
  assert.equal(behavior.hasPendingContext, false);
  assert.equal(behavior.requiresTrigger, false);
  assert.equal(behavior.resumeMode, 'manual_resume_dashboard');
});


test('pausa manual se puede reanudar con el siguiente inbound del candidato', () => {
  const candidate = {
    botPaused: true,
    botResumeMode: 'manual_resume_dashboard',
    botPauseReason: 'Conversacion tomada manualmente desde dashboard'
  };

  assert.equal(shouldBlockAutomation(candidate), true);
  assert.equal(shouldBlockAutomation(candidate, { direction: 'INBOUND' }), false);
  assert.equal(shouldResumeAutomationOnInbound(candidate), true);

  const update = buildInboundResumeUpdate(new Date('2026-05-15T10:00:00Z'));
  assert.equal(update.botPaused, false);
  assert.equal(update.botResumeMode, 'resumed_by_candidate_inbound');
  assert.equal(update.reminderState, 'CANCELLED');
});

test('pausa no manual sigue bloqueando automatizacion en inbound', () => {
  const candidate = {
    botPaused: true,
    botResumeMode: null,
    botPauseReason: 'Vacante con agenda habilitada sin slots validos disponibles'
  };

  assert.equal(shouldBlockAutomation(candidate, { direction: 'INBOUND' }), true);
  assert.equal(shouldResumeAutomationOnInbound(candidate), false);
});
