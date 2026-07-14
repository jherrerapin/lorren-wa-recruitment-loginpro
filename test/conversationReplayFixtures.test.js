import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const FIXTURES_ROOT = fileURLToPath(new URL('./conversation-replay/fixtures/', import.meta.url));

function collectJsonFiles(directory) {
  return readdirSync(directory)
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry);
      return statSync(fullPath).isDirectory()
        ? collectJsonFiles(fullPath)
        : (entry.endsWith('.json') ? [fullPath] : []);
    })
    .sort();
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} debe ser texto`);
  assert.ok(value.trim(), `${label} no puede estar vacío`);
}

function assertStringArray(value, label) {
  assert.ok(Array.isArray(value), `${label} debe ser un arreglo`);
  for (const [index, item] of value.entries()) {
    assertNonEmptyString(item, `${label}[${index}]`);
  }
}

function validateFixture(fixture, filePath) {
  const label = path.relative(FIXTURES_ROOT, filePath);

  assert.equal(fixture.schemaVersion, 1, `${label}: schemaVersion no soportada`);
  assertNonEmptyString(fixture.id, `${label}: id`);
  assertNonEmptyString(fixture.title, `${label}: title`);

  assert.ok(fixture.tenantContext && typeof fixture.tenantContext === 'object', `${label}: falta tenantContext`);
  assertNonEmptyString(fixture.tenantContext.tenantId, `${label}: tenantContext.tenantId`);
  assertNonEmptyString(fixture.tenantContext.channelId, `${label}: tenantContext.channelId`);
  assertNonEmptyString(fixture.tenantContext.provider, `${label}: tenantContext.provider`);

  assert.ok(fixture.policyContext && typeof fixture.policyContext === 'object', `${label}: falta policyContext`);
  assertNonEmptyString(fixture.policyContext.conversationPolicyVersion, `${label}: conversationPolicyVersion`);
  assertNonEmptyString(fixture.policyContext.vacancyPolicyVersion, `${label}: vacancyPolicyVersion`);
  assertNonEmptyString(fixture.policyContext.consentVersion, `${label}: consentVersion`);

  assert.ok(fixture.initialState && typeof fixture.initialState === 'object', `${label}: falta initialState`);
  assert.ok(fixture.initialState.candidate && typeof fixture.initialState.candidate === 'object', `${label}: falta initialState.candidate`);
  assert.ok(fixture.initialState.vacancy && typeof fixture.initialState.vacancy === 'object', `${label}: falta initialState.vacancy`);
  assertNonEmptyString(fixture.initialState.candidate.candidateId, `${label}: candidateId`);
  assertNonEmptyString(fixture.initialState.vacancy.vacancyId, `${label}: vacancyId`);

  assert.ok(Array.isArray(fixture.history), `${label}: history debe ser un arreglo`);
  assert.ok(fixture.inbound && typeof fixture.inbound === 'object', `${label}: falta inbound`);
  assertNonEmptyString(fixture.inbound.messageId, `${label}: inbound.messageId`);
  assert.ok(fixture.inbound.messageId.startsWith('test-'), `${label}: el messageId debe ser sintético`);
  assertNonEmptyString(fixture.inbound.type, `${label}: inbound.type`);
  assertNonEmptyString(fixture.inbound.body, `${label}: inbound.body`);

  const expected = fixture.expected;
  assert.ok(expected && typeof expected === 'object', `${label}: falta expected`);
  assert.ok(expected.understanding && typeof expected.understanding === 'object', `${label}: falta expected.understanding`);
  assertStringArray(expected.understanding.intents, `${label}: expected.understanding.intents`);
  assert.ok(expected.understanding.providedFields && typeof expected.understanding.providedFields === 'object', `${label}: falta providedFields`);

  assert.ok(expected.plan && typeof expected.plan === 'object', `${label}: falta expected.plan`);
  assertStringArray(expected.plan.actions, `${label}: expected.plan.actions`);
  assertStringArray(expected.plan.allowedWrites, `${label}: expected.plan.allowedWrites`);
  assertStringArray(expected.plan.forbiddenWrites, `${label}: expected.plan.forbiddenWrites`);
  assertNonEmptyString(expected.plan.nextStep, `${label}: expected.plan.nextStep`);

  const overlappingWrites = expected.plan.allowedWrites.filter((write) => expected.plan.forbiddenWrites.includes(write));
  assert.deepEqual(overlappingWrites, [], `${label}: una escritura no puede estar permitida y prohibida a la vez`);

  assert.ok(expected.response && typeof expected.response === 'object', `${label}: falta expected.response`);
  assertStringArray(expected.response.requiredFacts, `${label}: expected.response.requiredFacts`);
  assertStringArray(expected.response.forbiddenClaims, `${label}: expected.response.forbiddenClaims`);
  assert.ok(expected.finalState && typeof expected.finalState === 'object', `${label}: falta expected.finalState`);

  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/, `${label}: no debe contener correos reales`);
  assert.doesNotMatch(serialized, /\b3\d{9}\b/, `${label}: no debe contener teléfonos colombianos reales`);
}

test('el corpus conversacional contiene fixtures válidos, versionados y sin IDs duplicados', () => {
  const files = collectJsonFiles(FIXTURES_ROOT);
  assert.ok(files.length >= 3, 'el corpus inicial debe incluir al menos tres escenarios');

  const ids = new Set();
  for (const filePath of files) {
    const fixture = JSON.parse(readFileSync(filePath, 'utf8'));
    validateFixture(fixture, filePath);
    assert.ok(!ids.has(fixture.id), `id de fixture duplicado: ${fixture.id}`);
    ids.add(fixture.id);
  }
});
