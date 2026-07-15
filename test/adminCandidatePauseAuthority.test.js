import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/admin.js', 'utf8');

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return content.slice(startIndex, endIndex);
}

const pauseHandler = between(
  source,
  "router.post('/candidates/:id/bot-pause'",
  "router.post('/candidates/:id/bot-resume'"
);

const resumeHandler = between(
  source,
  "router.post('/candidates/:id/bot-resume'",
  '// ── CV: descargar'
);

test('admin importa los dos casos de uso de CandidateStateService', () => {
  assert.match(
    source,
    /import \{[\s\S]*pauseCandidateAutomationFromAdmin[\s\S]*resumeCandidateAutomationFromAdmin[\s\S]*\} from '\.\.\/services\/candidateStateService\.js';/
  );
});

test('los handlers administrativos no escriben Candidate directamente', () => {
  const directCandidateWrite = /prisma\.candidate\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/;
  assert.doesNotMatch(pauseHandler, directCandidateWrite);
  assert.doesNotMatch(resumeHandler, directCandidateWrite);
});

test('pausa administrativa delega snapshot completo y solo registra éxito aplicado', () => {
  assert.match(pauseHandler, /pauseCandidateAutomationFromAdmin\(prisma,\s*\{/);
  assert.match(pauseHandler, /botPaused:\s*candidate\.botPaused/);
  assert.match(pauseHandler, /botPausedAt:\s*candidate\.botPausedAt/);
  assert.match(pauseHandler, /botPausedBy:\s*candidate\.botPausedBy/);
  assert.match(pauseHandler, /botPauseReason:\s*candidate\.botPauseReason/);
  assert.match(pauseHandler, /botResumeMode:\s*candidate\.botResumeMode/);

  const transitionIndex = pauseHandler.indexOf('pauseCandidateAutomationFromAdmin');
  const conflictIndex = pauseHandler.indexOf('transition.count !== 1');
  const eventIndex = pauseHandler.indexOf("eventType: 'BOT_PAUSED'");
  const successIndex = pauseHandler.indexOf('Bot pausado correctamente.');

  assert.ok(transitionIndex >= 0);
  assert.ok(conflictIndex >= 0);
  assert.ok(eventIndex >= 0);
  assert.ok(successIndex >= 0);
  assert.ok(conflictIndex > transitionIndex);
  assert.ok(eventIndex > conflictIndex);
  assert.ok(successIndex > eventIndex);
});

test('reanudación administrativa delega snapshot completo y no levanta una pausa concurrente', () => {
  assert.match(resumeHandler, /resumeCandidateAutomationFromAdmin\(prisma,\s*\{/);
  assert.match(resumeHandler, /botPaused:\s*candidate\.botPaused/);
  assert.match(resumeHandler, /botPausedAt:\s*candidate\.botPausedAt/);
  assert.match(resumeHandler, /botPausedBy:\s*candidate\.botPausedBy/);
  assert.match(resumeHandler, /botPauseReason:\s*candidate\.botPauseReason/);
  assert.match(resumeHandler, /botResumeMode:\s*candidate\.botResumeMode/);

  const transitionIndex = resumeHandler.indexOf('resumeCandidateAutomationFromAdmin');
  const conflictIndex = resumeHandler.indexOf('transition.count !== 1');
  const eventIndex = resumeHandler.indexOf("eventType: 'BOT_RESUMED'");
  const successIndex = resumeHandler.indexOf('Bot reanudado correctamente.');

  assert.ok(transitionIndex >= 0);
  assert.ok(conflictIndex >= 0);
  assert.ok(eventIndex >= 0);
  assert.ok(successIndex >= 0);
  assert.ok(conflictIndex > transitionIndex);
  assert.ok(eventIndex > conflictIndex);
  assert.ok(successIndex > eventIndex);
});
