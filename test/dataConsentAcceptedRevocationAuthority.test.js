import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConsentBoundary } from '../src/services/dataConsentGate.js';

function textMessage(body, id = 'wa-revocation-test') {
  return {
    id,
    from: '573000000099',
    type: 'text',
    text: { body }
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
