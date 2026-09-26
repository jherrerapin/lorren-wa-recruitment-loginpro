import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildParitySnapshot,
  runConversationCase
} from './helpers/conversationHarness.js';

test('el candidato de lanzamiento conserva disponible el harness integral canónico', () => {
  assert.equal(typeof runConversationCase, 'function');
  assert.equal(typeof buildParitySnapshot, 'function');
});
