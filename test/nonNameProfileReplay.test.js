import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNaturalData } from '../src/services/candidateData.js';
import { isSuspiciousFullName, splitFieldDecisions } from '../src/services/debugTrace.js';
import { NON_NAME_PROFILE_REPLAYS } from './conversation-replay/nonNameProfileReplay.js';

test('replay CONV-032: una profesión propuesta por el motor no se persiste como nombre', () => {
  const replay = NON_NAME_PROFILE_REPLAYS.find((item) => item.id === 'conv-032-profession-is-not-name-v1');
  const decision = splitFieldDecisions(replay.proposedFields, {}, {
    sourceByField: replay.sourceByField
  });

  assert.deepEqual(decision.rejectedFields, replay.expected.rejectedFields);
  assert.deepEqual(decision.persistedFields, replay.expected.persistedFields);
  assert.equal(decision.persistedData.fullName ?? null, replay.expected.fullName);
  assert.equal(decision.suspiciousFullNameRejected, true);
  assert.equal(decision.rejectedNameReason, 'suspicious_engine');
});

test('replay CONV-064: un rasgo personal después de “soy” no se extrae como nombre', () => {
  const replay = NON_NAME_PROFILE_REPLAYS.find((item) => item.id === 'conv-064-trait-is-not-name-v1');
  const parsed = parseNaturalData(replay.inbound);

  assert.equal(parsed.fullName ?? null, replay.expected.parsedFullName);
  assert.equal(isSuspiciousFullName(replay.expected.suspiciousCandidate), true);
});

test('un nombre explícito real sigue siendo válido', () => {
  const replay = NON_NAME_PROFILE_REPLAYS.find((item) => item.id === 'valid-explicit-name-remains-supported-v1');
  const parsed = parseNaturalData(replay.inbound);

  assert.equal(parsed.fullName, replay.expected.parsedFullName);
  assert.equal(isSuspiciousFullName(parsed.fullName), false);
});

test('un nombre real consolida un valor ocupacional persistido previamente', () => {
  const replay = NON_NAME_PROFILE_REPLAYS.find((item) => item.id === 'valid-name-corrects-suspicious-persisted-value-v1');
  const decision = splitFieldDecisions(replay.proposedFields, replay.candidate, {
    sourceByField: replay.sourceByField
  });

  assert.equal(decision.persistedData.fullName, replay.expected.persistedFullName);
  assert.deepEqual(decision.consolidatedFields, replay.expected.consolidatedFields);
  assert.deepEqual(decision.rejectedFields, []);
});
