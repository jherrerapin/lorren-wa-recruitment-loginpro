import test from 'node:test';
import assert from 'node:assert/strict';
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

function createPrismaMock() {
  const calls = {
    candidateUpdates: [],
    consentEvents: [],
    transactions: []
  };

  const prisma = {
    candidate: {
      update: ({ where, data }) => {
        calls.candidateUpdates.push({ where, data });
        return Promise.resolve({ id: where.id, ...data });
      }
    },
    candidateDataConsentEvent: {
      create: ({ data }) => {
        calls.consentEvents.push(data);
        return Promise.resolve({ id: 'consent-event-test-1', ...data });
      }
    },
    $transaction: async (operations) => {
      calls.transactions.push(operations);
      return Promise.all(operations);
    }
  };

  return { prisma, calls };
}

test('ACCEPTED actualiza candidato y crea evento dentro de una sola transacción', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await recordCandidateDataConsent(prisma, {
    ...BASE_INPUT,
    status: 'accepted',
    candidatePatch: {
      currentStep: 'COLLECTING_DATA',
      botResumeMode: null,
      lastInboundAt: FIXED_NOW
    }
  });

  assert.equal(calls.transactions.length, 1);
  assert.equal(calls.transactions[0].length, 2);
  assert.equal(calls.candidateUpdates.length, 1);
  assert.equal(calls.consentEvents.length, 1);

  const candidateData = calls.candidateUpdates[0].data;
  assert.equal(calls.candidateUpdates[0].where.id, BASE_INPUT.candidateId);
  assert.equal(candidateData.dataConsentStatus, 'ACCEPTED');
  assert.equal(candidateData.dataConsentVersion, BASE_INPUT.version);
  assert.equal(candidateData.dataConsentText, BASE_INPUT.text);
  assert.equal(candidateData.dataConsentSource, BASE_INPUT.source);
  assert.equal(candidateData.dataConsentRecordedBy, 'test-operator');
  assert.equal(candidateData.currentStep, 'COLLECTING_DATA');
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
  assert.equal(result.candidate.dataConsentStatus, 'ACCEPTED');
  assert.equal(result.event.status, 'ACCEPTED');
});

test('REVOKED limpia aceptación y registra una única fecha de revocatoria', async () => {
  const { prisma, calls } = createPrismaMock();

  await recordCandidateDataConsent(prisma, {
    ...BASE_INPUT,
    status: 'REVOKED',
    candidatePatch: {
      currentStep: 'DONE',
      status: 'NUEVO'
    }
  });

  const candidateData = calls.candidateUpdates[0].data;
  assert.equal(candidateData.dataConsentStatus, 'REVOKED');
  assert.equal(candidateData.dataConsentAcceptedAt, null);
  assert.equal(candidateData.dataConsentRevokedAt.toISOString(), FIXED_NOW.toISOString());
  assert.equal(candidateData.currentStep, 'DONE');
  assert.equal(candidateData.status, 'NUEVO');
  assert.equal(calls.consentEvents[0].status, 'REVOKED');
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
