import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';

const SENSITIVE_FIELD_NAMES = new Set([
  'phone',
  'phoneNumber',
  'documentNumber',
  'email'
]);

const TEXTUAL_INBOUND_TYPES = new Set(['text', 'interactive']);
const ATTACHMENT_INBOUND_TYPES = new Set(['document', 'image']);

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
  const fragments = [
    fixture?.inbound?.body,
    fixture?.inbound?.caption,
    fixture?.inbound?.attachment?.fileName
  ];
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
    `${label}: no debe contener números de documento reales en el texto conversacional o nombre del archivo`
  );
}

function validateProviderStubs(fixture, label) {
  const aiResult = fixture?.providerStubs?.aiResult;
  assert.ok(aiResult && typeof aiResult === 'object' && !Array.isArray(aiResult), `${label}: falta providerStubs.aiResult`);
  assertNonEmptyString(aiResult.status, `${label}: providerStubs.aiResult.status`);
  assertNonEmptyString(aiResult.intent, `${label}: providerStubs.aiResult.intent`);
  assert.ok(aiResult.parsedFields && typeof aiResult.parsedFields === 'object' && !Array.isArray(aiResult.parsedFields), `${label}: parsedFields debe ser un objeto`);
  assert.ok(aiResult.extraction && typeof aiResult.extraction === 'object' && !Array.isArray(aiResult.extraction), `${label}: falta extraction`);
  assertNonEmptyString(aiResult.extraction.turnType, `${label}: extraction.turnType`);
  assert.ok(aiResult.extraction.fieldEvidence && typeof aiResult.extraction.fieldEvidence === 'object' && !Array.isArray(aiResult.extraction.fieldEvidence), `${label}: fieldEvidence debe ser un objeto`);
  assert.ok(Array.isArray(aiResult.extraction.conflicts), `${label}: extraction.conflicts debe ser un arreglo`);
}

function validateExecutionContext(fixture, label) {
  if (!fixture.executionContext) return;
  assert.ok(typeof fixture.executionContext === 'object' && !Array.isArray(fixture.executionContext), `${label}: executionContext debe ser un objeto`);
  assertNonEmptyString(fixture.executionContext.now, `${label}: executionContext.now`);
  assert.ok(Number.isFinite(Date.parse(fixture.executionContext.now)), `${label}: executionContext.now debe ser ISO-8601 válido`);
}

function validateInbound(fixture, label) {
  const inbound = fixture.inbound;
  assert.ok(inbound && typeof inbound === 'object', `${label}: falta inbound`);
  assertNonEmptyString(inbound.messageId, `${label}: inbound.messageId`);
  assert.ok(inbound.messageId.startsWith('test-'), `${label}: el messageId debe ser sintético`);
  assertNonEmptyString(inbound.type, `${label}: inbound.type`);

  if (TEXTUAL_INBOUND_TYPES.has(inbound.type)) {
    assertNonEmptyString(inbound.body, `${label}: inbound.body`);
    return;
  }

  assert.ok(ATTACHMENT_INBOUND_TYPES.has(inbound.type), `${label}: inbound.type no soportado`);
  assert.ok(inbound.attachment && typeof inbound.attachment === 'object' && !Array.isArray(inbound.attachment), `${label}: falta inbound.attachment`);
  assertNonEmptyString(inbound.attachment.fileName, `${label}: inbound.attachment.fileName`);
  assert.ok(inbound.attachment.fileName.startsWith('TEST-'), `${label}: el nombre del adjunto debe ser sintético y comenzar por TEST-`);
  assertNonEmptyString(inbound.attachment.mimeType, `${label}: inbound.attachment.mimeType`);
  assert.ok(Number.isInteger(inbound.attachment.sizeBytes) && inbound.attachment.sizeBytes > 0, `${label}: inbound.attachment.sizeBytes debe ser entero positivo`);
  if (Object.hasOwn(inbound, 'body')) assert.equal(typeof inbound.body, 'string', `${label}: inbound.body opcional debe ser texto`);
  if (Object.hasOwn(inbound, 'caption')) assert.equal(typeof inbound.caption, 'string', `${label}: inbound.caption opcional debe ser texto`);
}

function validateFixture(fixture, label) {
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
  validateExecutionContext(fixture, label);
  validateProviderStubs(fixture, label);

  assert.ok(fixture.initialState && typeof fixture.initialState === 'object', `${label}: falta initialState`);
  assert.ok(fixture.initialState.candidate && typeof fixture.initialState.candidate === 'object', `${label}: falta initialState.candidate`);
  assert.ok(fixture.initialState.vacancy && typeof fixture.initialState.vacancy === 'object', `${label}: falta initialState.vacancy`);
  assertNonEmptyString(fixture.initialState.candidate.candidateId, `${label}: candidateId`);
  assertNonEmptyString(fixture.initialState.vacancy.vacancyId, `${label}: vacancyId`);
  assert.equal(typeof fixture.initialState.vacancy.isActive, 'boolean', `${label}: vacancy.isActive debe ser booleano`);
  assert.equal(typeof fixture.initialState.vacancy.acceptingApplications, 'boolean', `${label}: vacancy.acceptingApplications debe ser booleano`);

  assert.ok(Array.isArray(fixture.history), `${label}: history debe ser un arreglo`);
  validateInbound(fixture, label);

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
  assertStringArray(expected.response.requiredText, `${label}: expected.response.requiredText`);
  assertStringArray(expected.response.forbiddenText, `${label}: expected.response.forbiddenText`);
  assert.ok(expected.finalState && typeof expected.finalState === 'object', `${label}: falta expected.finalState`);

  inspectStructuredSensitiveValues(fixture, label);
  assertNoSensitiveConversationText(fixture, label);
}

test('el corpus conversacional contiene fixtures válidos, versionados y con proveedores simulados', () => {
  const entries = loadConversationFixtures();
  assert.ok(entries.length >= 6, 'el corpus debe incluir al menos seis escenarios protegidos');

  const fixtureIds = new Set();
  const inboundMessageIds = new Set();

  for (const { fixture, relativePath } of entries) {
    validateFixture(fixture, relativePath);

    assert.ok(!fixtureIds.has(fixture.id), `id de fixture duplicado: ${fixture.id}`);
    fixtureIds.add(fixture.id);

    assert.ok(
      !inboundMessageIds.has(fixture.inbound.messageId),
      `inbound.messageId duplicado entre fixtures: ${fixture.inbound.messageId}`
    );
    inboundMessageIds.add(fixture.inbound.messageId);
  }
});
