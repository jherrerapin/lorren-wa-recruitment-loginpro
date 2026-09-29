import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { executeReplayTurn } from './conversation-replay/replayHarness.js';

const fixtureEntries = loadConversationFixtures();

test('un fixture legacy de revocación atraviesa el nuevo núcleo funcional', async () => {
  const entry = fixtureEntries
    .find(({ relativePath }) => relativePath.replaceAll('\\', '/').endsWith('consent/revocation-after-accepted.json'));
  assert.ok(entry, 'fixture de revocación no encontrado');

  const { input, decision } = await executeReplayTurn(entry.fixture);

  assert.equal(input.turn.rawText, entry.fixture.inbound.body);
  assert.equal(input.execution.dryRun, true);
  assert.equal(decision.transitions.endConversation, true);
  assert.equal(decision.scheduling?.action ?? 'none', 'none');
  assert.match(decision.reply.text, /No continuaré con la postulación/);
});

for (const entry of fixtureEntries) {
  test(`fixture funcional: ${entry.fixture.id}`, async () => {
    const { input, decision } = await executeReplayTurn(entry.fixture);
    const actions = new Set((entry.fixture.expected?.plan?.actions || []).map((action) => action.type));
    const parsedFields = entry.fixture.providerStubs?.aiResult?.parsedFields || {};

    assert.equal(input.turn.id, entry.fixture.inbound.messageId);
    assert.equal(decision.scheduling?.action ?? 'none', 'none');

    if (actions.has('ASK_DATA_CONSENT')) {
      assert.match(decision.reply?.text || '', /datos personales/);
      assert.equal(decision.mutations.nextStep, 'AWAITING_DATA_CONSENT');
    }
    if (actions.has('STOP_APPLICATION')) {
      assert.equal(decision.transitions.endConversation, true);
    }
    if (actions.has('RECORD_DATA_CONSENT') && /autorizo/i.test(input.turn.rawText) && !/^no\b/i.test(input.turn.rawText)) {
      assert.equal(decision.mutations.fieldsToPersist.dataConsentStatus, 'ACCEPTED');
    }
    if (actions.has('SAVE_CANDIDATE_FIELDS') || actions.has('UPDATE_CANDIDATE_FIELDS')) {
      for (const [field, value] of Object.entries(parsedFields)) {
        assert.deepEqual(decision.mutations.fieldsToPersist[field], value, field);
      }
    }
    const expectedPending = entry.fixture.expected?.finalState?.pendingFields;
    if (Array.isArray(expectedPending) && expectedPending.length) {
      assert.equal(decision.reply?.directive, 'ASK_MISSING_FIELDS');
      assert.deepEqual(decision.reply.parameters.missingFields, expectedPending);
      assert.equal(decision.transitions.keepCurrentStep, true);
    }
  });
}

test('el replay documental considera el CV procesado como evidencia del turno', async () => {
  const { input } = await executeReplayTurn({
    id: 'cv-current-turn-replay',
    candidate: {
      id: 'candidate-cv-current-turn',
      phone: '573000000099',
      dataConsentStatus: 'ACCEPTED',
      currentStep: 'ASK_CV',
      updatedAt: '2026-07-14T15:00:00.000Z'
    },
    inbound: {
      messageId: 'message-cv-current-turn',
      type: 'document',
      attachment: {
        id: 'media-cv-current-turn',
        mime_type: 'application/pdf',
        filename: 'hv.pdf',
        extractedText: 'Hoja de vida sintética procesada.',
        status: 'processed'
      }
    }
  });

  assert.equal(input.attachments.current[0].status, 'processed');
  assert.equal(input.pending.fields.includes('cv'), false);
});
