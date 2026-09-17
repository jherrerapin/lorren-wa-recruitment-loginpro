import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildParitySnapshot,
  runConversationCase
} from './helpers/conversationHarness.js';
import { conversationCases } from './fixtures/conversationCases.js';
import { buildFutureSlot } from './helpers/mockScheduler.js';
import { processText } from '../src/routes/webhook.js';
import { createDebugTrace } from '../src/services/debugTrace.js';

test('el candidato de lanzamiento reutiliza el harness integral canónico', () => {
  assert.equal(typeof runConversationCase, 'function');
  assert.equal(typeof buildParitySnapshot, 'function');
});


test('replay #901: una candidata completa accede a la misma agenda neutral', async () => {
  const source = conversationCases.find(({ id }) => id === 'female-pipeline-after-cv');
  assert.ok(source);
  const replay = {
    ...source,
    id: 'audit-901-neutral-scheduling-female',
    candidate: {
      ...source.candidate,
      fullName: 'Persona Prueba',
      documentNumber: 'TEST-901-0001',
      vacancyId: 'vac-sched',
      neighborhood: null,
      locality: 'Funza'
    },
    interviewSlots: [buildFutureSlot({ vacancyId: 'vac-sched', id: 'slot-audit-901', hoursFromNow: 8 })],
    expect: {
      candidate: { currentStep: 'SCHEDULING', botPaused: false },
      lastReplyIncludes: ['te puedo agendar entrevista']
    }
  };

  await runConversationCase(replay, {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true
  });
});
