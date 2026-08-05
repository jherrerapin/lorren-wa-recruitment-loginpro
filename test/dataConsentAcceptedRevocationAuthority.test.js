import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dataConsentGateMiddleware,
  evaluateConsentBoundary
} from '../src/services/dataConsentGate.js';

function textMessage(body, id = 'wa-revocation-test') {
  return {
    id,
    from: '573000000099',
    type: 'text',
    text: { body }
  };
}

function webhookPayload(message) {
  return {
    entry: [{
      changes: [{
        value: { messages: [message] }
      }]
    }]
  };
}

const acceptedCandidate = {
  id: 'candidate-revocation-test',
  dataConsentStatus: 'ACCEPTED',
  currentStep: 'COLLECTING_DATA',
  botResumeMode: null
};

test('A1: una revocación explícita tiene prioridad sobre el retorno por consentimiento ACCEPTED', () => {
  const result = evaluateConsentBoundary(
    acceptedCandidate,
    textMessage('Quiero retirar mi autorización y eliminar mi información. No deseo continuar.')
  );

  assert.deepEqual(result, {
    block: true,
    reason: 'explicit_consent_revocation'
  });
});

test('A1: un mensaje ordinario conserva el paso normal cuando el consentimiento sigue ACCEPTED', () => {
  const result = evaluateConsentBoundary(
    acceptedCandidate,
    textMessage('Tengo experiencia en inventarios y despacho de mercancía.')
  );

  assert.deepEqual(result, {
    block: false,
    reason: 'consent_already_accepted'
  });
});

test('A1: una revocación ya persistida permanece bloqueada y no vuelve al flujo de captura', () => {
  const result = evaluateConsentBoundary(
    {
      ...acceptedCandidate,
      dataConsentStatus: 'REVOKED',
      currentStep: 'DONE',
      botPaused: true
    },
    textMessage('Solicito nuevamente borrar mis datos y detener el proceso.', 'wa-revocation-retry')
  );

  assert.equal(result.block, true);
  assert.equal(result.reason, 'explicit_consent_revocation');
});

test('A1: reintentar el mismo webhook con REVOKED persistido no crea otro evento ni otra respuesta', async () => {
  const persistedInboundIds = new Set();
  const writes = {
    consentEvents: 0,
    outboundMessages: 0,
    candidateUpdates: 0,
    nextCalls: 0,
    statuses: []
  };
  const revokedCandidate = {
    ...acceptedCandidate,
    dataConsentStatus: 'REVOKED',
    currentStep: 'DONE',
    botPaused: true
  };
  const prisma = {
    candidate: {
      upsert: async () => revokedCandidate,
      update: async () => {
        writes.candidateUpdates += 1;
        return revokedCandidate;
      }
    },
    candidateDataConsentEvent: {
      create: async () => {
        writes.consentEvents += 1;
        return {};
      }
    },
    message: {
      createMany: async ({ data }) => {
        const waMessageId = data[0].waMessageId;
        if (persistedInboundIds.has(waMessageId)) return { count: 0 };
        persistedInboundIds.add(waMessageId);
        return { count: 1 };
      },
      create: async () => {
        writes.outboundMessages += 1;
        return {};
      }
    }
  };
  const middleware = dataConsentGateMiddleware(prisma);
  const message = textMessage(
    'Reitero que deseo borrar mis datos y detener el proceso.',
    'wa-revocation-idempotent-001'
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const req = {
      body: webhookPayload(structuredClone(message)),
      headers: {},
      ip: '127.0.0.1'
    };
    const res = {
      sendStatus: (status) => {
        writes.statuses.push(status);
        return status;
      }
    };
    const next = () => {
      writes.nextCalls += 1;
    };

    await middleware(req, res, next);
  }

  assert.equal(persistedInboundIds.size, 1);
  assert.equal(writes.consentEvents, 0);
  assert.equal(writes.outboundMessages, 0);
  assert.equal(writes.candidateUpdates, 0);
  assert.equal(writes.nextCalls, 0);
  assert.deepEqual(writes.statuses, [200, 200]);
});
