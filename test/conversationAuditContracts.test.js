import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routeSource = fs.readFileSync(new URL('../src/routes/conversationAudit.js', import.meta.url), 'utf8');
const hubSource = fs.readFileSync(new URL('../src/routes/lorenV2.js', import.meta.url), 'utf8');
const serviceSource = fs.readFileSync(new URL('../src/services/conversationAudit.js', import.meta.url), 'utf8');
const policySource = fs.readFileSync(new URL('../src/services/conversationAuditPolicy.js', import.meta.url), 'utf8');

test('auditoría es solo DEV y no ejecuta escrituras', () => {
  assert.match(routeSource, /req\.userRole !== 'dev'/);
  assert.match(routeSource, /router\.use\(requireDev\)/);
  assert.doesNotMatch(serviceSource + policySource, /prisma\.[a-zA-Z]+\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\s*\(/);
});

test('auditoría no llama OpenAI ni consume tokens', () => {
  assert.doesNotMatch(routeSource + serviceSource + policySource, /OPENAI_API_KEY|api\.openai\.com|axios|chat\/completions|responses/);
  assert.match(routeSource, /no llama a OpenAI ni consume tokens/);
});

test('centro de estadísticas monta y muestra la auditoría solo para DEV', () => {
  assert.match(hubSource, /router\.use\('\/conversation-audit', conversationAuditRouter/);
  assert.match(hubSource, /req\.userRole === 'dev'/);
  assert.match(hubSource, /Auditoría conversacional/);
});

test('exportación es anónima y la página incorpora favicon', () => {
  assert.match(routeSource, /export\.json/);
  assert.match(serviceSource + policySource, /piiRedacted/);
  assert.match(routeSource, /favicon-loginpro\.svg/);
});
