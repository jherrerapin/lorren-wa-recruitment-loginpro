import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function sliceFunctionBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `falta ${startMarker}`);
  assert.ok(end > start, `falta cierre para ${startMarker}`);
  return source.slice(start, end);
}

test('replay seudonimizado: auxiliar sin entrada no avanza visualmente a almuerzo', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  const normalizeSource = sliceFunctionBlock(
    nativePresence,
    'function normalizeMarkType(value)',
    '\n  function markInfo'
  );
  const projectionSource = sliceFunctionBlock(
    nativePresence,
    'function persistedMarkAt(member, markType)',
    '\n  function formatPersistedMarkTime'
  );
  const helpers = Function(`
    const MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
    ${normalizeSource}
    ${projectionSource}
    return { memberEligibleForMark, memberPresentationMarkType };
  `)();

  const auxiliaryWithArrival = {
    isLeader: false,
    attendance: {
      arrivalAt: '2026-08-26T23:01:00.000Z',
      breakStartAt: null,
      breakEndAt: null,
      departureAt: null
    }
  };
  const auxiliaryWithoutArrival = {
    isLeader: false,
    attendance: {
      arrivalAt: null,
      breakStartAt: null,
      breakEndAt: null,
      departureAt: null
    }
  };

  assert.equal(helpers.memberPresentationMarkType(auxiliaryWithArrival, 'BREAK_START'), 'BREAK_START');
  assert.equal(helpers.memberEligibleForMark(auxiliaryWithArrival, 'BREAK_START'), true);
  assert.equal(helpers.memberPresentationMarkType(auxiliaryWithoutArrival, 'BREAK_START'), 'ARRIVAL');
  assert.equal(helpers.memberEligibleForMark(auxiliaryWithoutArrival, 'BREAK_START'), false);

  const expectedCountSource = sliceFunctionBlock(
    nativePresence,
    'function expectedAuxiliaryProofCount(context, markType)',
    '\n  function pendingAuxiliaryCount'
  );
  assert.doesNotMatch(expectedCountSource, /memberEligibleForMark/);

  const pendingCountSource = sliceFunctionBlock(
    nativePresence,
    'function pendingAuxiliaryCount(context, markType)',
    '\n  function memberStatusPresentation'
  );
  assert.match(pendingCountSource, /memberEligibleForMark\(member, markType\)/);

  const renderSource = sliceFunctionBlock(
    nativePresence,
    'function renderCrewMembers(panel, context, markType)',
    '\n  function randomToken'
  );
  assert.match(renderSource, /memberPresentationMarkType\(member, normalizedMark\)/);
  assert.match(renderSource, /memberStatus\(context, member, memberMarkType\)/);
  assert.match(renderSource, /memberStatusPresentation\(status, memberMarkType\)/);
});
