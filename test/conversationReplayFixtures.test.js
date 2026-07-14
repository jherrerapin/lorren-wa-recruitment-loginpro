import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const FIXTURES_ROOT = fileURLToPath(new URL('./conversation-replay/fixtures/', import.meta.url));
const SENSITIVE_FIELD_NAMES = new Set([
  'phone',
  'phoneNumber',
  'documentNumber',
  'email'
]);

function collectJsonFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? collectJsonFiles(fullPath)
        : (entry.name.endsWith('.json') ? [fullPath] : []);
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

function assertActionArray(value, label) {
  assert.ok(Array.isArray(value), `${label} debe ser un arreglo`);
  assert.ok(value.length > 0, `${label} debe contener al menos una acción`);

  for (const [index, action] of value.entries()) {
    assert.ok(action && typeof action === 'object' && !Array.isArray(action), `${label}[${index}] debe ser un objeto`);
    assertNonEmptyString(action.type, `${label}[${index}].type`);
    if (Object.hasOwn(action, 'data')) {
      assert.ok(action.data && typeof action.data === 'object' && !Array.isArray(action.data), `${label}[${index}].data debe ser un objeto`);
    }
  }
}

function inspectStructuredSensitiveValues(value, label = 'fixture') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectStructuredSensitiveValues(item, `${label}[${index}]`));
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedLabel = `${label}.${key}`;
    if (SENSITIVE_FIELD_NAMES.has(key) && nestedValue !== null && nestedValue !== undefined && String(nestedValue).trim()) {
      const syntheticValue = String(nestedValue).trim();
      assert.ok(
        syntheticValue.startsWith('TEST-'),
        `${nestedLabel} debe usar un valor sintético con prefijo TEST-`
      );
    }
    inspectStructuredSensitiveValues(nestedValue, nestedLabel);
  }
}

function collectConversationText(fixture) {
  const fragments = [fixture?.inbound?.body];
  for (const message of fixture?.history || []) fragments.push(message?.body);
  return fragments.filter((fragment) => typeof fragment === 'string').join('\n');
}

function assertNoSensitiveConversationText(fixture, label) {
  const text = collectConversationText(fixture);
  assert.doesNotMatch(text, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/, `${label}: no debe contener correos reales`);
  assert.doesNotMatch(
    text,
    /(?:\+?57[\s.-]?)?3\d{2}(?:[\s.-]?\d{3}){2}/,
    `${label}: no debe contener teléfonos colombianos reales o formateados`
  );
  assert.doesNotMatch(
    text,
    /(^|\D)\d{6,12}(?=\D|$)/,
    `${label}: no debe contener números de documento reales en el texto conversacional`
  );
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
  assert.equal(typeof fixture.initialState.vacancy.isActive, 'boolean', `${label}: vacancy.isActive debe ser booleano`);
  assert.equal(typeof fixture.initialState.vacancy.acceptingApplications, 'boolean', `${label}: vacancy.acceptingApplications debe ser booleano`);

  assert.ok(Array.isArray(fixture.history), `${label}: history debe ser un arreglo`);
  assert.ok(fixture.inbound && typeof fixture.inbound === 'object', `${label}: falta inbound`);
  assertNonEmptyString(fixture.inbound.messageId, `${label}: inbound.messageId`);
  assert.ok(fixture.inbound.messageId.startsWith('test-'), `${label}: el messageId debe ser sintético`);
  assertNonEmptyString(fixture.inbound.type, `${label}: inbound.type`);
  assertNonEmptyString(fixture.inbound.body, `${label}: inbound.body`);

  const expected = fixture.expected;
  assert.ok(expected && typeof expected === 'object', `${label}: falta expected`);
  assert.ok(expected.interpretation && typeof expected.interpretation === 'object', `${label}: falta expected.interpretation`);
  assertNonEmptyString(expected.interpretation.intent, `${label}: expected.interpretation.intent`);
  assertStringArray(expected.interpretation.additionalIntents, `${label}: expected.interpretation.additionalIntents`);
  assert.ok(expected.interpretation.providedFields && typeof expected.interpretation.providedFields === 'object', `${label}: falta providedFields`);
  if (expected.interpretation.consentDecision !== null && expected.interpretation.consentDecision !== undefined) {
    assertNonEmptyString(expected.interpretation.consentDecision, `${label}: expected.interpretation.consentDecision`);
  }

  assert.ok(expected.plan && typeof expected.plan === 'object', `${label}: falta expected.plan`);
  assertActionArray(expected.plan.actions, `${label}: expected.plan.actions`);
  assertStringArray(expected.plan.allowedWrites, `${label}: expected.plan.allowedWrites`);
  assertStringArray(expected.plan.forbiddenWrites, `${label}: expected.plan.forbiddenWrites`);
  assertNonEmptyString(expected.plan.nextStep, `${label}: expected.plan.nextStep`);

  const overlappingWrites = expected.plan.allowedWrites.filter((write) => expected.plan.forbiddenWrites.includes(write));
  assert.deepEqual(overlappingWrites, [], `${label}: una escritura no puede estar permitida y prohibida a la vez`);

  assert.ok(expected.response && typeof expected.response === 'object', `${label}: falta expected.response`);
  assertStringArray(expected.response.requiredFacts, `${label}: expected.response.requiredFacts`);
  assertStringArray(expected.response.forbiddenClaims, `${label}: expected.response.forbiddenClaims`);
  assert.ok(expected.finalState && typeof expected.finalState === 'object', `${label}: falta expected.finalState`);

  inspectStructuredSensitiveValues(fixture, label);
  assertNoSensitiveConversationText(fixture, label);
}

test('el corpus conversacional contiene fixtures válidos, versionados y con identidades únicas', () => {
  const files = collectJsonFiles(FIXTURES_ROOT);
  assert.ok(files.length >= 3, 'el corpus inicial debe incluir al menos tres escenarios');

  const fixtureIds = new Set();
  const inboundMessageIds = new Set();

  for (const filePath of files) {
    let fixture;
    try {
      fixture = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      const relativePath = path.relative(FIXTURES_ROOT, filePath);
      assert.fail(`Error al parsear JSON en ${relativePath}: ${error.message}`);
    }

    validateFixture(fixture, filePath);

    assert.ok(!fixtureIds.has(fixture.id), `id de fixture duplicado: ${fixture.id}`);
    fixtureIds.add(fixture.id);

    assert.ok(
      !inboundMessageIds.has(fixture.inbound.messageId),
      `inbound.messageId duplicado entre fixtures: ${fixture.inbound.messageId}`
    );
    inboundMessageIds.add(fixture.inbound.messageId);
  }
});
