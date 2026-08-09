import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFieldDecisions } from '../src/services/debugTrace.js';
import { NAME_RESIDENCE_COLLISION_REPLAYS } from './conversation-replay/nameResidenceCollisionReplay.js';

for (const replay of NAME_RESIDENCE_COLLISION_REPLAYS) {
  test(`replay ${replay.sourceConversation}: ${replay.title}`, () => {
    const decision = splitFieldDecisions(replay.proposedFields, replay.candidate, {
      sourceByField: replay.sourceByField
    });

    assert.deepEqual(decision.persistedFields, replay.expected.persistedFields);
    assert.deepEqual(decision.rejectedFields, replay.expected.rejectedFields);

    if (Object.hasOwn(replay.expected, 'neighborhood')) {
      assert.equal(decision.persistedData.neighborhood ?? null, replay.expected.neighborhood);
    }
    if (Object.hasOwn(replay.expected, 'locality')) {
      assert.equal(decision.persistedData.locality ?? null, replay.expected.locality);
    }
  });
}
