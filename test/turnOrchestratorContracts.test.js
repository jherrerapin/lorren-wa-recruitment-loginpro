import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const webhookSource = fs.readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
const adminSource = fs.readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');

test('webhook delega vacancyId de ASSIGN_VACANCY_AND_CONTINUE a CandidateStateService', () => {
  const assignStart = webhookSource.indexOf('VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE');
  assert.notEqual(assignStart, -1);
  const assignEnd = webhookSource.indexOf('if (candidate.currentStep === ConversationStep.MENU)', assignStart);
  assert.notEqual(assignEnd, -1);
  const assignBlock = webhookSource.slice(assignStart, assignEnd);

  assert.match(webhookSource, /applyCandidateVacancyFirstGateDecision/);
  assert.match(assignBlock, /applyVacancyFirstGateUpdates\(\{[\s\S]*vacancyId:\s*vacancyFirstGateDecision\.vacancyId/);
  assert.match(assignBlock, /currentStep:\s*nextStep/);
  assert.match(assignBlock, /if\s*\(!applied\.applied\)\s*return;/);
  assert.doesNotMatch(assignBlock, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
});

test('webhook registra silencio intencional con payload interno', () => {
  assert.match(webhookSource, /async function recordIntentionalSilence/);
  assert.match(webhookSource, /visibility:\s*'internal'/);
  assert.match(webhookSource, /neverSendToCandidate:\s*true/);
  assert.match(webhookSource, /source:\s*'bot_silence_trace'/);
});

test('envío manual de información de vacante queda etiquetado como intervención humana y valida vacante activa', () => {
  assert.match(adminSource, /actor:\s*rawPayload\?\.actor === 'ADMIN' \? 'ADMIN' : 'RECRUITER'/);
  assert.match(adminSource, /manualIntervention:\s*true/);
  assert.match(adminSource, /source:\s*'admin_manual_vacancy_info'/);
  assert.match(adminSource, /!candidate\.vacancy\.isActive \|\| !candidate\.vacancy\.acceptingApplications/);
});
