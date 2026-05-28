import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const webhookSource = fs.readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
const adminSource = fs.readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');

test('webhook solo persiste vacancyId desde ASSIGN_VACANCY_AND_CONTINUE del vacancyFirstGate', () => {
  const vacancyWrites = [...webhookSource.matchAll(/data:\s*\{[^}]*vacancyId[^}]*\}/gs)].map((match) => match[0]);
  assert.equal(vacancyWrites.length, 1);
  assert.match(vacancyWrites[0], /vacancyFirstGateDecision\.vacancyId/);
  assert.match(webhookSource, /VacancyFirstGateAction\.ASSIGN_VACANCY_AND_CONTINUE/);
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
