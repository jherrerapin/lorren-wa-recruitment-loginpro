import test from 'node:test';
import assert from 'node:assert/strict';
import { describeResumeBehavior, shouldBlockAutomation } from '../src/services/botAutomationPolicy.js';

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
