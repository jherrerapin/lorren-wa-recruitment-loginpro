import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateConsentBoundary,
  evaluateProfileDataEvidence
} from '../src/services/dataConsentGate.js';
import {
  PRE_CONSENT_DATA_EVIDENCE_INCOMPLETE,
  PRE_CONSENT_DATA_EVIDENCE_REPLAYS
} from './conversation-replay/preConsentDataEvidenceReplay.js';

function textMessage(body, id = 'TEST-WAMID-DATA-EVIDENCE') {
  return { id, from: 'TEST-PHONE-DATA-EVIDENCE', type: 'text', text: { body } };
}

test('las 18 apariciones completas solo afirman datos cuando existe evidencia explícita del inbound actual', () => {
  const complete = PRE_CONSENT_DATA_EVIDENCE_REPLAYS.filter((item) => item.sourceConversation.startsWith('CONV-'));
  const candidateContext = {
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    vacancyId: 'TEST-VACANCY-DATA-EVIDENCE'
  };
  assert.equal(complete.length, 18);

  for (const replay of complete) {
    const result = evaluateProfileDataEvidence(replay.body, { candidate: candidateContext });
    assert.equal(result.containsProfileData, false, replay.id);
    assert.deepEqual(result.evidence, [], replay.id);
    assert.notEqual(
      evaluateConsentBoundary(candidateContext, textMessage(replay.body)).reason,
      'profile_data_before_consent',
      replay.id
    );
  }
});

test('las cuatro apariciones sin inbound visible permanecen como evidencia insuficiente', () => {
  assert.deepEqual(PRE_CONSENT_DATA_EVIDENCE_INCOMPLETE, ['CONV-002', 'CONV-039', 'CONV-050', 'CONV-064']);
});

test('la autoridad estructurada separa negativos, ambiguos y datos explícitos', () => {
  for (const replay of PRE_CONSENT_DATA_EVIDENCE_REPLAYS) {
    const result = evaluateProfileDataEvidence(replay.body);
    assert.deepEqual(result.evidence.map((item) => item.field), replay.expectedFields, replay.id);
    assert.equal(result.containsProfileData, replay.expectedFields.length > 0, replay.id);
    for (const evidence of result.evidence) {
      assert.equal(evidence.source, 'CURRENT_INBOUND_EXPLICIT');
      assert.ok(evidence.confidence >= 0.95);
      assert.ok(evidence.rule);
    }
  }
});

test('un resultado ambiguo del modelo no puede convertir profesión en nombre ni experiencia en residencia', () => {
  const result = evaluateProfileDataEvidence('Trabajo en despachos', {
    parsedFields: {
      fullName: 'Trabajo En Despachos',
      neighborhood: 'Despachos'
    },
    sourceByField: {
      fullName: 'openai',
      neighborhood: 'openai'
    }
  });
  assert.equal(result.containsProfileData, false);
  assert.deepEqual(result.evidence, []);
});

test('datos históricos y metadata de campaña no justifican una afirmación sobre el turno actual', () => {
  const result = evaluateProfileDataEvidence('Hola', {
    candidate: { fullName: 'Nombre Histórico de Prueba', neighborhood: 'Barrio Histórico de Prueba' },
    campaignMetadata: { city: 'Neiva', role: 'Cargo de Prueba' }
  });
  assert.equal(result.containsProfileData, false);
  assert.deepEqual(result.evidence, []);
});
