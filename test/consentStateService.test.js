import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep } from '@prisma/client';
import {
  buildConsentStateMutation,
  recordCandidateDataConsent
} from '../src/services/consentStateService.js';

const FIXED_NOW = new Date('2026-07-14T15:00:00.000Z');
const BASE_INPUT = Object.freeze({
  candidateId: 'candidate-test-consent-1',
  version: 'consent-test-v1',
  text: 'Texto sintético de autorización para pruebas.',
  source: 'TEST_SOURCE',
  actorUsername: ' test-operator ',
  ipAddress: ' 127.0.0.1 ',
  userAgent: ' test-agent ',
  note: ' nota de prueba ',
  now: FIXED_NOW
});

function createPersistenceDelegates(calls, {
  persistedStep = ConversationStep.GREETING_SENT,
  stepUpdateCount = 1
} = {}) {
  let currentStep = persistedStep;
  return {
    candidate: {
      updateMany: async ({ where, data }) => {
        calls.stepUpdates.push({ where, data });
        if (stepUpdateCount === 1) currentStep = data.currentStep;
        return { count: stepUpdateCount };
      },
      findUnique: async ({ where }) => ({ id: where.id, currentStep }),
      update: async ({ where, data }) => {
        calls.candidateUpdates.push({ where, data });
        return { id: where.id, currentStep, ...data };
      }
    },
    candidateDataConsentEvent: {
      create: async ({ data }) => {
        calls.consentEvents.push(data);
        return { id: 'consent-event-test-1', ...data };
      }
    }
  };
}

function createPrismaMock(options = {}) {
  const calls = {
    candidateUpdates: [],
    stepUpdates: [],
    consentEvents: [],
    transactions: []
  };
  const delegates = createPersistenceDelegates(calls, options);
  const prisma = {
    ...delegates,
    $transaction: async (operation) => {
      calls.transactions.push(operation);
      return operation(delegates);
    }
  };

  return { prisma, calls };
}

function createTransactionClientMock(options = {}) {
  const calls = {
    candidateUpdates: [],
    stepUpdates: [],
    consentEvents: []
  };
  return {
    transactionClient: createPersistenceDelegates(calls, options),
    calls
  };
}

test('ACCEPTED coordina currentStep, candidato y evento en una sola transacción', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await recordCandidateDataConsent(prisma, {
    ...BASE_INPUT,
    status: 'accepted',
    expected: { currentStep: ConversationStep.GREETING_SENT },
    candidatePatch: {
      currentStep: ConversationStep.COLLECTING_DATA,
      botResumeMode: null,
      lastInboundAt: FIXED_NOW
    }
  });

  assert.equal(calls.transactions.length, 1);
  assert.equal(calls.stepUpdates.length, 1);
  assert.equal(calls.candidateUpdates.length, 1);
  assert.equal(calls.consentEvents.length, 1);

  assert.deepEqual(calls.stepUpdates[0], {
    where: {
      id: BASE_INPUT.candidateId,
      currentStep: ConversationStep.GREETING_SENT
    },
    data: { currentStep: ConversationStep.COLLECTING_DATA }
  });

  const candidateData = calls.candidateUpdates[0].data;
  assert.equal(Object.hasOwn(candidateData, 'currentStep'), false);
  assert.equal(candidateData.dataConsentStatus, 'ACCEPTED');
  assert.equal(candidateData.dataConsentVersion, BASE_INPUT.version);
  assert.equal(candidateData.dataConsentText, BASE_INPUT.text);
  assert.equal(candidateData.dataConsentSource, BASE_INPUT.source);
  assert.equal(candidateData.dataConsentRecordedBy, 'test-operator');
  assert.equal(candidateData.botResumeMode, null);
  assert.equal(candidateData.dataConsentAcceptedAt.toISOString(), FIXED_NOW.toISOString());
  assert.equal(candidateData.dataConsentRevokedAt, null);

  const eventData = calls.consentEvents[0];
  assert.equal(eventData.candidateId, BASE_INPUT.candidateId);
  assert.equal(eventData.status, 'ACCEPTED');
  assert.equal(eventData.version, BASE_INPUT.version);
  assert.equal(eventData.text, BASE_INPUT.text);
  assert.equal(eventData.source, BASE_INPUT.source);
  assert.equal(eventData.actorUsername, 'test-operator');
  assert.equal(eventData.ipAddress, '127.0.0.1');
  assert.equal(eventData.userAgent, 'test-agent');
  assert.equal(eventData.note, 'nota de prueba');
  assert.equal(result.recordedAt.toISOString(), FIXED_NOW.toISOString());
  assert.equal(result.candidate.currentStep, ConversationStep.COLLECTING_DATA);
  assert.equal(result.event.status, 'ACCEPTED');
  assert.equal(result.stepTransition.count, 1);
  assert.equal(result.conflict, false);
});

test('permite registrar consentimiento cuando el destino coincide con el paso actual', async () => {
  const { prisma, calls } = createPrismaMock({ persistedStep: ConversationStep.COLLECTING_DATA });

  const result = await recordCandidateDataConsent(prisma, {
    ...BASE_INPUT,
    status: 'ACCEPTED',
    expected: { currentStep: ConversationStep.COLLECTING_DATA },
    candidatePatch: { currentStep: ConversationStep.COLLECTING_DATA }
  });

  assert.equal(result.conflict, false);
  assert.equal(result.stepTransition.count, 1);
  assert.equal(calls.candidateUpdates.length, 1);
  assert.equal(calls.consentEvents.length, 1);
});

test('una carrera de currentStep revierte consentimiento y evento', async () => {
  const { prisma, calls } = createPrismaMock({
    persistedStep: ConversationStep.ASK_CV,
    stepUpdateCount: 0
  });

  const result = await recordCandidateDataConsent(prisma, {
    ...BASE_INPUT,
    status: 'ACCEPTED',
    expected: { currentStep: ConversationStep.GREETING_SENT },
    candidatePatch: { currentStep: ConversationStep.COLLECTING_DATA }
  });

  assert.equal(result.conflict, true);
  assert.equal(result.event, null);
  assert.equal(result.candidate.currentStep, ConversationStep.ASK_CV);
  assert.equal(result.stepTransition.count, 0);
  assert.equal(calls.candidateUpdates.length, 0);
  assert.equal(calls.consentEvents.length, 0);
});

test('la autoridad usa un cliente tx existente sin abrir una transacción anidada', async () => {
  const { transactionClient, calls } = createTransactionClientMock();

  const result = await recordCandidateDataConsent(transactionClient, {
    ...BASE_INPUT,
    status: 'ACCEPTED',
    expected: { currentStep: ConversationStep.GREETING_SENT },
    candidatePatch: { currentStep: ConversationStep.COLLECTING_DATA }
  });

  assert.equal(Object.hasOwn(transactionClient, '$transaction'), false);
  assert.equal(calls.stepUpdates.length, 1);
  assert.equal(calls.candidateUpdates.length, 1);
  assert.equal(calls.consentEvents.length, 1);
  assert.equal(result.candidate.currentStep, ConversationStep.COLLECTING_DATA);
  assert.equal(result.event.status, 'ACCEPTED');
});

test('REVOKED coordina el destino DONE y mantiene la trazabilidad', async () => {
  const { prisma, calls } = createPrismaMock();

  await recordCandidateDataConsent(prisma, {
    ...BASE_INPUT,
    status: 'REVOKED',
    expected: { currentStep: ConversationStep.GREETING_SENT },
    candidatePatch: {
      currentStep: ConversationStep.DONE,
      status: 'NUEVO'
    }
  });

  const candidateData = calls.candidateUpdates[0].data;
  assert.equal(candidateData.dataConsentStatus, 'REVOKED');
  assert.equal(candidateData.dataConsentAcceptedAt, null);
  assert.equal(candidateData.dataConsentRevokedAt.toISOString(), FIXED_NOW.toISOString());
  assert.equal(Object.hasOwn(candidateData, 'currentStep'), false);
  assert.equal(candidateData.status, 'NUEVO');
  assert.equal(calls.stepUpdates[0].data.currentStep, ConversationStep.DONE);
  assert.equal(calls.consentEvents[0].status, 'REVOKED');
});

test('un registro administrativo sin currentStep no exige snapshot', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await recordCandidateDataConsent(prisma, {
    ...BASE_INPUT,
    status: 'ACCEPTED'
  });

  assert.equal(calls.stepUpdates.length, 0);
  assert.equal(calls.candidateUpdates.length, 1);
  assert.equal(calls.consentEvents.length, 1);
  assert.equal(result.stepTransition, null);
  assert.equal(result.conflict, false);
});

test('currentStep en candidatePatch exige expected antes de persistir', async () => {
  const { prisma, calls } = createPrismaMock();

  await assert.rejects(
    () => recordCandidateDataConsent(prisma, {
      ...BASE_INPUT,
      status: 'ACCEPTED',
      candidatePatch: { currentStep: ConversationStep.COLLECTING_DATA }
    }),
    /candidate_consent_expected_current_step_required/
  );

  assert.equal(calls.transactions.length, 0);
  assert.equal(calls.stepUpdates.length, 0);
  assert.equal(calls.candidateUpdates.length, 0);
  assert.equal(calls.consentEvents.length, 0);
});

test('los campos canónicos de consentimiento no pueden sobreescribirse desde candidatePatch', () => {
  assert.throws(
    () => buildConsentStateMutation({
      ...BASE_INPUT,
      status: 'ACCEPTED',
      candidatePatch: { dataConsentStatus: 'REVOKED' }
    }),
    /candidate_patch_field_not_allowed:dataConsentStatus/
  );
});

test('rechaza estados, fechas y contratos Prisma inválidos antes de persistir', async () => {
  assert.throws(
    () => buildConsentStateMutation({ ...BASE_INPUT, status: 'PENDING' }),
    /consent_status_unsupported:PENDING/
  );
  assert.throws(
    () => buildConsentStateMutation({ ...BASE_INPUT, status: 'ACCEPTED', now: 'fecha-inválida' }),
    /consent_timestamp_invalid/
  );
  await assert.rejects(
    () => recordCandidateDataConsent({ candidate: { update: true } }, { ...BASE_INPUT, status: 'ACCEPTED' }),
    /consent_prisma_contract_invalid/
  );
});

test('normaliza valores opcionales vacíos a null', async () => {
  const { prisma, calls } = createPrismaMock();

  await recordCandidateDataConsent(prisma, {
    ...BASE_INPUT,
    status: 'ACCEPTED',
    actorUsername: '   ',
    ipAddress: '',
    userAgent: null,
    note: undefined
  });

  assert.equal(calls.candidateUpdates[0].data.dataConsentRecordedBy, null);
  assert.equal(calls.consentEvents[0].actorUsername, null);
  assert.equal(calls.consentEvents[0].ipAddress, null);
  assert.equal(calls.consentEvents[0].userAgent, null);
  assert.equal(calls.consentEvents[0].note, null);
});
