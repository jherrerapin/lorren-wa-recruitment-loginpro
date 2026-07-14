import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { createInMemoryReplayAdapters } from './conversation-replay/inMemoryAdapters.js';
import { replayFixtureIntegral } from './conversation-replay/integralReplay.js';

function countAudit(snapshot, type) {
  return snapshot.auditEvents.filter((event) => event.type === type).length;
}

function assertExpectedState(fixture, snapshot, label) {
  const aggregateState = {
    ...snapshot.candidates[0],
    pendingFields: snapshot.conversationState.pendingFields
  };

  for (const [field, expectedValue] of Object.entries(fixture.expected.finalState)) {
    assert.deepEqual(
      aggregateState[field],
      expectedValue,
      `${label}: estado inesperado en ${field}`
    );
  }
}

function stableBusinessSnapshot(snapshot) {
  return {
    candidates: snapshot.candidates,
    conversationState: snapshot.conversationState,
    inboundMessages: snapshot.inboundMessages,
    outboundMessages: snapshot.outboundMessages
  };
}

test('una caída después del outbox se recupera sin reinterpretar ni repetir cambios', async (t) => {
  for (const { fixture, relativePath } of loadConversationFixtures()) {
    await t.test(relativePath, async () => {
      const adapters = createInMemoryReplayAdapters(fixture, {
        failures: { deliverOutbound: 1 }
      });

      await assert.rejects(
        () => replayFixtureIntegral(fixture, adapters),
        /simulated_delivery_failure:/,
        `${relativePath}: el primer intento debe fallar después de persistir el outbox`
      );

      const afterFailure = adapters.snapshot();
      assert.equal(afterFailure.inboundMessages.length, 1, `${relativePath}: la entrada debe quedar reclamada`);
      assert.equal(afterFailure.outboundMessages.length, 1, `${relativePath}: la salida debe quedar persistida`);
      assert.equal(afterFailure.deliveries.length, 0, `${relativePath}: la salida no debe figurar como entregada`);
      assert.equal(afterFailure.deliveryAttempts.length, 1, `${relativePath}: debe existir un intento de entrega`);
      assert.equal(afterFailure.deliveryAttempts[0].attempts, 1, `${relativePath}: el contador inicial debe ser uno`);
      assert.equal(countAudit(afterFailure, 'OUTBOUND_PERSISTED'), 1, `${relativePath}: el outbox solo debe persistirse una vez`);
      assert.equal(countAudit(afterFailure, 'OUTBOUND_DELIVERY_FAILED'), 1, `${relativePath}: el fallo debe quedar auditado`);
      assert.equal(countAudit(afterFailure, 'OUTBOUND_DELIVERED'), 0, `${relativePath}: no puede existir entrega exitosa todavía`);
      assertExpectedState(fixture, afterFailure, relativePath);

      const candidateUpdateCountAfterFailure = countAudit(afterFailure, 'CANDIDATE_UPDATED');
      const businessStateAfterFailure = stableBusinessSnapshot(afterFailure);
      const outboundBody = afterFailure.outboundMessages[0].body;
      const lastOutboundAt = afterFailure.candidates[0].lastOutboundAt;

      const recovery = await replayFixtureIntegral(fixture, adapters);
      assert.equal(recovery.duplicate, true, `${relativePath}: el reintento conserva la identidad duplicada`);
      assert.equal(recovery.resumedProcessing, false, `${relativePath}: no debe reprocesar cuando ya existe outbox`);
      assert.equal(recovery.recoveryAttempted, true, `${relativePath}: debe intentar recuperar el outbox pendiente`);
      assert.equal(recovery.recovered, true, `${relativePath}: la entrega pendiente debe recuperarse`);
      assert.equal(recovery.interpreted, false, `${relativePath}: la recuperación no debe reinterpretar`);
      assert.equal(recovery.planned, false, `${relativePath}: la recuperación no debe replanificar`);
      assert.deepEqual(recovery.appliedWrites, [], `${relativePath}: la recuperación no debe repetir escrituras`);
      assert.equal(recovery.reply, outboundBody, `${relativePath}: debe entregar exactamente el cuerpo persistido`);

      const afterRecovery = recovery.snapshot;
      assert.deepEqual(
        stableBusinessSnapshot(afterRecovery),
        businessStateAfterFailure,
        `${relativePath}: candidato, conversación, inbox y outbox no deben cambiar durante la recuperación`
      );
      assert.equal(afterRecovery.candidates[0].lastOutboundAt, lastOutboundAt, `${relativePath}: lastOutboundAt no debe reescribirse`);
      assert.equal(afterRecovery.deliveries.length, 1, `${relativePath}: debe existir una única entrega exitosa`);
      assert.equal(afterRecovery.deliveryAttempts[0].attempts, 2, `${relativePath}: la recuperación debe ser el segundo intento`);
      assert.equal(countAudit(afterRecovery, 'CANDIDATE_UPDATED'), candidateUpdateCountAfterFailure, `${relativePath}: no debe repetirse ninguna actualización del candidato`);
      assert.equal(countAudit(afterRecovery, 'OUTBOUND_PERSISTED'), 1, `${relativePath}: no debe persistirse otro outbox`);
      assert.equal(countAudit(afterRecovery, 'OUTBOUND_DELIVERY_FAILED'), 1, `${relativePath}: debe conservarse un único fallo`);
      assert.equal(countAudit(afterRecovery, 'OUTBOUND_DELIVERED'), 1, `${relativePath}: debe auditarse una única entrega exitosa`);

      const deliveredSnapshot = afterRecovery;
      const finalDuplicate = await replayFixtureIntegral(fixture, adapters);
      assert.equal(finalDuplicate.duplicate, true, `${relativePath}: la tercera recepción sigue siendo duplicada`);
      assert.equal(finalDuplicate.resumedProcessing, false, `${relativePath}: una salida ya entregada no debe reprocesarse`);
      assert.equal(finalDuplicate.recoveryAttempted, false, `${relativePath}: una salida ya entregada no necesita recuperación`);
      assert.equal(finalDuplicate.recovered, false, `${relativePath}: no debe declarar otra recuperación`);
      assert.equal(finalDuplicate.reply, null, `${relativePath}: no debe volver a responder`);
      assert.deepEqual(finalDuplicate.snapshot, deliveredSnapshot, `${relativePath}: la tercera recepción debe ser un no-op total`);
    });
  }
});

test('una caída entre inbox y outbox revierte cambios parciales y reanuda el turno', async (t) => {
  for (const { fixture, relativePath } of loadConversationFixtures()) {
    await t.test(relativePath, async () => {
      const adapters = createInMemoryReplayAdapters(fixture, {
        failures: { persistOutbound: 1 }
      });

      await assert.rejects(
        () => replayFixtureIntegral(fixture, adapters),
        /simulated_outbound_persistence_failure:/,
        `${relativePath}: el primer intento debe fallar dentro del commit de estado y outbox`
      );

      const afterRollback = adapters.snapshot();
      assert.equal(afterRollback.inboundMessages.length, 1, `${relativePath}: el inbox debe conservar el reclamo`);
      assert.equal(afterRollback.outboundMessages.length, 0, `${relativePath}: no debe quedar un outbox parcial`);
      assert.equal(afterRollback.deliveryAttempts.length, 0, `${relativePath}: no debe intentarse entregar sin outbox`);
      assert.equal(afterRollback.deliveries.length, 0, `${relativePath}: no debe existir entrega`);
      assert.deepEqual(afterRollback.candidates[0], fixture.initialState.candidate, `${relativePath}: los cambios del candidato deben revertirse`);
      assert.deepEqual(afterRollback.conversationState.pendingFields, fixture.initialState.pendingFields || [], `${relativePath}: el pendiente conversacional debe revertirse`);
      assert.equal(countAudit(afterRollback, 'INBOUND_CLAIMED'), 1, `${relativePath}: el reclamo debe permanecer auditado`);
      assert.equal(countAudit(afterRollback, 'CANDIDATE_UPDATED'), 0, `${relativePath}: la auditoría de cambios parciales debe revertirse`);
      assert.equal(countAudit(afterRollback, 'OUTBOUND_PERSISTED'), 0, `${relativePath}: no debe auditarse un outbox inexistente`);

      const resumed = await replayFixtureIntegral(fixture, adapters);
      assert.equal(resumed.duplicate, true, `${relativePath}: la entrada continúa reclamada`);
      assert.equal(resumed.resumedProcessing, true, `${relativePath}: debe reanudar procesamiento al no existir outbox`);
      assert.equal(resumed.interpreted, true, `${relativePath}: el turno incompleto debe reinterpretarse`);
      assert.equal(resumed.planned, true, `${relativePath}: el turno incompleto debe replanificarse`);
      assert.equal(resumed.recoveryAttempted, false, `${relativePath}: no es una recuperación de entrega`);
      assert.equal(resumed.recovered, false, `${relativePath}: no debe marcarse como entrega recuperada`);
      assert.deepEqual(
        [...resumed.appliedWrites].sort(),
        [...fixture.expected.plan.allowedWrites].sort(),
        `${relativePath}: el commit reanudado debe aplicar una sola vez todas las escrituras autorizadas`
      );

      const afterResume = resumed.snapshot;
      assert.equal(afterResume.inboundMessages.length, 1, `${relativePath}: no debe duplicarse el inbox`);
      assert.equal(afterResume.outboundMessages.length, 1, `${relativePath}: debe existir un único outbox`);
      assert.equal(afterResume.deliveries.length, 1, `${relativePath}: debe existir una única entrega`);
      assert.equal(countAudit(afterResume, 'INBOUND_CLAIMED'), 1, `${relativePath}: el reclamo no debe duplicarse`);
      assert.equal(countAudit(afterResume, 'OUTBOUND_PERSISTED'), 1, `${relativePath}: el outbox debe persistirse una sola vez`);
      assert.equal(countAudit(afterResume, 'OUTBOUND_DELIVERED'), 1, `${relativePath}: la entrega debe ejecutarse una sola vez`);
      assertExpectedState(fixture, afterResume, relativePath);

      const completedSnapshot = afterResume;
      const finalDuplicate = await replayFixtureIntegral(fixture, adapters);
      assert.equal(finalDuplicate.resumedProcessing, false, `${relativePath}: el turno completado no debe reanudarse otra vez`);
      assert.equal(finalDuplicate.reply, null, `${relativePath}: no debe emitir una segunda respuesta`);
      assert.deepEqual(finalDuplicate.snapshot, completedSnapshot, `${relativePath}: el duplicado final debe ser un no-op total`);
    });
  }
});

test('el puerto de entrega exige el candidato y cuerpo comprometidos en el outbox', () => {
  const [{ fixture }] = loadConversationFixtures();
  const adapters = createInMemoryReplayAdapters(fixture);
  const candidateId = fixture.initialState.candidate.candidateId;
  const idempotencyKey = 'test-outbound-contract:reply:v1';
  const body = 'Respuesta persistida de prueba';

  assert.equal(adapters.persistOutbound({
    tenantContext: fixture.tenantContext,
    policyContext: fixture.policyContext,
    requestedCandidateId: candidateId,
    idempotencyKey,
    body
  }), true);

  assert.throws(
    () => adapters.deliverOutbound({
      tenantContext: fixture.tenantContext,
      requestedCandidateId: 'candidate-test-foreign',
      idempotencyKey,
      body
    }),
    /outbound_candidate_mismatch:/
  );

  assert.throws(
    () => adapters.deliverOutbound({
      tenantContext: fixture.tenantContext,
      requestedCandidateId: candidateId,
      idempotencyKey,
      body: 'Respuesta diferente'
    }),
    /outbound_body_mismatch:/
  );

  const snapshot = adapters.snapshot();
  assert.equal(snapshot.deliveryAttempts.length, 0);
  assert.equal(snapshot.deliveries.length, 0);
  assert.equal(countAudit(snapshot, 'OUTBOUND_DELIVERY_FAILED'), 0);
  assert.equal(countAudit(snapshot, 'OUTBOUND_DELIVERED'), 0);
});
