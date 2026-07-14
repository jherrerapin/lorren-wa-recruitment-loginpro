import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { createInMemoryReplayAdapters } from './conversation-replay/inMemoryAdapters.js';
import { replayFixtureIntegral } from './conversation-replay/integralReplay.js';

function sorted(values) {
  return [...values].sort();
}

function assertExpectedFinalState(expectedFinalState, snapshot, label) {
  assert.equal(snapshot.candidates.length, 1, `${label}: debe existir un único candidato`);
  const aggregateState = {
    ...snapshot.candidates[0],
    pendingFields: snapshot.conversationState.pendingFields
  };

  for (const [field, expectedValue] of Object.entries(expectedFinalState)) {
    assert.deepEqual(
      aggregateState[field],
      expectedValue,
      `${label}: estado integral inesperado en ${field}`
    );
  }
}

function assertResponseContract(responseContract, reply, label) {
  const normalizedReply = reply.toLocaleLowerCase('es-CO');

  for (const requiredText of responseContract.requiredText) {
    assert.ok(
      normalizedReply.includes(requiredText.toLocaleLowerCase('es-CO')),
      `${label}: la respuesta no contiene el texto obligatorio: ${requiredText}`
    );
  }

  for (const forbiddenText of responseContract.forbiddenText) {
    assert.ok(
      !normalizedReply.includes(forbiddenText.toLocaleLowerCase('es-CO')),
      `${label}: la respuesta contiene una afirmación prohibida: ${forbiddenText}`
    );
  }
}

function assertTenantTraceability(snapshot, fixture, label) {
  const records = [
    ...snapshot.inboundMessages,
    ...snapshot.outboundMessages,
    ...snapshot.deliveries
  ];

  for (const record of records) {
    assert.equal(record.tenantId, fixture.tenantContext.tenantId, `${label}: tenantId incorrecto`);
    assert.equal(record.channelId, fixture.tenantContext.channelId, `${label}: channelId incorrecto`);
    assert.equal(record.provider, fixture.tenantContext.provider, `${label}: provider incorrecto`);
  }

  for (const message of [...snapshot.inboundMessages, ...snapshot.outboundMessages]) {
    assert.deepEqual(message.policyContext, fixture.policyContext, `${label}: se perdió la versión de políticas`);
  }
}

function assertIntegralEffects(firstReplay, fixture, label) {
  const snapshot = firstReplay.snapshot;
  assert.equal(firstReplay.duplicate, false, `${label}: el primer procesamiento no puede ser duplicado`);
  assert.equal(firstReplay.interpreted, true, `${label}: el turno debe interpretarse`);
  assert.equal(firstReplay.planned, true, `${label}: el turno debe planificarse`);
  assert.deepEqual(
    sorted(firstReplay.appliedWrites),
    sorted(fixture.expected.plan.allowedWrites),
    `${label}: las escrituras ejecutadas no coinciden con el plan autorizado`
  );

  assert.equal(snapshot.inboundMessages.length, 1, `${label}: debe persistirse un único mensaje entrante`);
  assert.equal(snapshot.outboundMessages.length, 1, `${label}: debe persistirse un único mensaje saliente`);
  assert.equal(snapshot.deliveries.length, 1, `${label}: debe realizarse una única entrega`);
  assert.equal(snapshot.inboundMessages[0].messageId, fixture.inbound.messageId, `${label}: messageId entrante incorrecto`);
  assert.equal(snapshot.inboundMessages[0].body, fixture.inbound.body, `${label}: cuerpo entrante incorrecto`);
  assert.equal(snapshot.outboundMessages[0].body, firstReplay.reply, `${label}: la salida persistida difiere de la respuesta`);
  assert.equal(snapshot.deliveries[0].body, firstReplay.reply, `${label}: la entrega difiere de la respuesta persistida`);
  assert.equal(snapshot.outboundMessages[0].idempotencyKey, firstReplay.outboundIdempotencyKey, `${label}: clave de salida incorrecta`);
  assert.equal(snapshot.deliveries[0].idempotencyKey, firstReplay.outboundIdempotencyKey, `${label}: clave de entrega incorrecta`);

  const auditTypes = snapshot.auditEvents.map((event) => event.type);
  assert.ok(auditTypes.includes('INBOUND_CLAIMED'), `${label}: falta auditoría de entrada`);
  assert.ok(auditTypes.includes('OUTBOUND_PERSISTED'), `${label}: falta auditoría de persistencia saliente`);
  assert.ok(auditTypes.includes('OUTBOUND_DELIVERED'), `${label}: falta auditoría de entrega`);

  assertExpectedFinalState(fixture.expected.finalState, snapshot, label);
  assertResponseContract(fixture.expected.response, firstReplay.reply, label);
  assertTenantTraceability(snapshot, fixture, label);
}

test('el replay integral aplica el plan una sola vez y detiene reentregas antes de interpretar', async (t) => {
  for (const { fixture, relativePath } of loadConversationFixtures()) {
    await t.test(relativePath, async () => {
      const adapters = createInMemoryReplayAdapters(fixture);
      const firstReplay = await replayFixtureIntegral(fixture, adapters);
      assertIntegralEffects(firstReplay, fixture, relativePath);

      const stateAfterFirstReplay = firstReplay.snapshot;
      const duplicateReplay = await replayFixtureIntegral(fixture, adapters);

      assert.equal(duplicateReplay.duplicate, true, `${relativePath}: la reentrega debe detectarse como duplicada`);
      assert.equal(duplicateReplay.interpreted, false, `${relativePath}: un duplicado no debe reinterpretarse`);
      assert.equal(duplicateReplay.planned, false, `${relativePath}: un duplicado no debe replanificarse`);
      assert.deepEqual(duplicateReplay.appliedWrites, [], `${relativePath}: un duplicado no debe escribir estado`);
      assert.equal(duplicateReplay.reply, null, `${relativePath}: un duplicado no debe generar respuesta`);
      assert.deepEqual(
        duplicateReplay.snapshot,
        stateAfterFirstReplay,
        `${relativePath}: un duplicado no debe alterar repositorios, outbox, entregas ni auditoría`
      );
    });
  }
});

test('los adaptadores en memoria rechazan un TenantContext diferente', () => {
  const [{ fixture }] = loadConversationFixtures();
  const adapters = createInMemoryReplayAdapters(fixture);
  const foreignTenantContext = {
    ...fixture.tenantContext,
    tenantId: 'tenant-cross-access-test'
  };

  assert.throws(
    () => adapters.readCandidate(foreignTenantContext, fixture.initialState.candidate.candidateId),
    /tenant_context_mismatch:tenantId/
  );
});
