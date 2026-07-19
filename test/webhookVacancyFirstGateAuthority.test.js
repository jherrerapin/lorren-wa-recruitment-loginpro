import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/webhook.js', 'utf8');
const optionalReturnBlockPattern = /if\s*\(!applied\.applied\)\s*(?:\{\s*)?return;?\s*\}?/;

function extractFunctionSource(functionName) {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = signature.exec(source);
  assert.ok(match, `No se encontró ${functionName}`);
  const openingBrace = source.indexOf('{', source.indexOf(')', match.index) + 1);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`Cuerpo incompleto para ${functionName}`);
}

test('processText delega candidateUpdates del gate con snapshot completo', () => {
  const processText = extractFunctionSource('processText');
  assert.match(source, /applyCandidateVacancyFirstGateDecision/);
  assert.match(processText, /expected:\s*buildVacancyFirstGateExpected\(\)/);
  assert.match(processText, /currentStep:\s*candidate\.currentStep/);
  assert.match(processText, /vacancyId:\s*candidate\.vacancyId\s*\?\?\s*null/);
  assert.match(processText, /botResumeMode:\s*candidate\.botResumeMode\s*\?\?\s*null/);
  assert.match(processText, /reminderScheduledFor:\s*candidate\.reminderScheduledFor\s*\?\?\s*null/);
  assert.match(processText, /reminderState:\s*candidate\.reminderState\s*\?\?\s*['"]NONE['"]/);
});

test('un conflicto se registra antes de cualquier respuesta del gate', () => {
  const processText = extractFunctionSource('processText');
  const conflictIndex = processText.indexOf('if (transition.count !== 1)');
  assert.notEqual(conflictIndex, -1);

  const silenceMatch = /reason:\s*['"]STALE_CANDIDATE_VACANCY_FIRST_GATE['"]/.exec(
    processText.slice(conflictIndex)
  );
  assert.ok(silenceMatch);
  const silenceIndex = conflictIndex + silenceMatch.index;
  const replyBranchIndex = processText.indexOf('VacancyFirstGateAction.REPLY', conflictIndex);
  assert.notEqual(replyBranchIndex, -1);
  assert.ok(conflictIndex < silenceIndex);
  assert.ok(silenceIndex < replyBranchIndex);
  assert.match(processText, optionalReturnBlockPattern);
});

test('la asignación de vacante usa la misma autoridad y no escribe Candidate directamente', () => {
  const processText = extractFunctionSource('processText');
  const assignStart = processText.indexOf('VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE');
  assert.notEqual(assignStart, -1);
  const assignEnd = processText.indexOf('if (candidate.currentStep === ConversationStep.MENU)', assignStart);
  assert.notEqual(assignEnd, -1);
  const assignBlock = processText.slice(assignStart, assignEnd);
  assert.match(assignBlock, /applyVacancyFirstGateUpdates\(\{[\s\S]*vacancyId:[\s\S]*currentStep:\s*nextStep/);
  assert.match(assignBlock, optionalReturnBlockPattern);
  assert.doesNotMatch(assignBlock, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
});

test('el wrapper del gate no conserva escrituras directas por ID', () => {
  const processText = extractFunctionSource('processText');
  const helperStart = processText.indexOf('const applyVacancyFirstGateUpdates');
  assert.notEqual(helperStart, -1);
  const helperEnd = processText.indexOf('const maybeSilentCaptureProfileData', helperStart);
  assert.notEqual(helperEnd, -1);
  const helper = processText.slice(helperStart, helperEnd);
  assert.match(helper, /applyCandidateVacancyFirstGateDecision/);
  assert.doesNotMatch(helper, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
});
