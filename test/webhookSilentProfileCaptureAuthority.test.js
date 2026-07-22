import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/webhook.js', 'utf8');

function extractProcessText() {
  const start = source.indexOf('export async function processText');
  assert.notEqual(start, -1);
  const openingBrace = source.indexOf('{', source.indexOf(')', start) + 1);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('Cuerpo incompleto para processText');
}

function extractSilentCaptureHelper() {
  const processText = extractProcessText();
  const start = processText.indexOf('const maybeSilentCaptureProfileData');
  assert.notEqual(start, -1);
  const end = processText.indexOf('if (vacancyFirstGateDecision.action', start);
  assert.notEqual(end, -1);
  return processText.slice(start, end);
}

test('webhook delega la persistencia silenciosa a CandidateStateService', () => {
  const helper = extractSilentCaptureHelper();
  assert.match(source, /applyCandidateSilentProfileCapture/);
  assert.match(helper, /applyCandidateSilentProfileCapture\s*\(\s*prisma/);
  assert.match(helper, /profileFields/);
  assert.match(helper, /candidate\[field\]\s*\?\?\s*null/);
  assert.match(helper, /currentStep:\s*candidate\.currentStep/);
  assert.match(helper, /vacancyId:\s*candidate\.vacancyId\s*\?\?\s*null/);
  assert.match(helper, /botResumeMode:\s*candidate\.botResumeMode\s*\?\?\s*null/);
  assert.doesNotMatch(helper, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
});

test('un conflicto se registra y detiene cualquier respuesta silenciosa', () => {
  const helper = extractSilentCaptureHelper();
  const conflictIndex = helper.indexOf('if (transition.count !== 1)');
  const staleIndex = helper.indexOf('STALE_CANDIDATE_SILENT_PROFILE_CAPTURE');
  const replyIndex = helper.indexOf('buildSilentProfileCaptureReply');

  assert.notEqual(conflictIndex, -1);
  assert.notEqual(staleIndex, -1);
  assert.notEqual(replyIndex, -1);
  assert.ok(conflictIndex < staleIndex);
  assert.ok(staleIndex < replyIndex);
  assert.match(helper, /conflict:\s*true/);
  assert.match(helper, /return\s+true;/);
});

test('la respuesta usa el candidato observado después del CAS exitoso', () => {
  const helper = extractSilentCaptureHelper();
  const observedIndex = helper.indexOf('candidate = transition.candidate || candidate');
  const replyIndex = helper.indexOf('buildSilentProfileCaptureReply');
  assert.notEqual(observedIndex, -1);
  assert.notEqual(replyIndex, -1);
  assert.ok(observedIndex < replyIndex);
});
