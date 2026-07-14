import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_CONSENT_VERSION } from '../src/services/dataConsentGate.js';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { replayFixtureInterpretation } from './conversation-replay/interpretationReplay.js';

function assertSemanticEvidence(expectedIntent, replay, fixture, label) {
  const { turn, understanding, attachment } = replay.evidence;

  if (expectedIntent === 'CONTINUE_APPLICATION') {
    assert.equal(turn.interest, true, `${label}: el arbitraje debe reconocer interés`);
    assert.equal(replay.interpretation.consentDecision, null, `${label}: el interés no puede autorizar datos`);
  }

  if (expectedIntent === 'ACCEPT_DATA_CONSENT') {
    assert.equal(replay.interpretation.consentDecision, 'ACCEPTED', `${label}: debe reconocer autorización explícita`);
    assert.deepEqual(understanding.candidateFields, {}, `${label}: autorizar no debe inventar datos de perfil`);
  }

  if (expectedIntent === 'REJECT_DATA_CONSENT') {
    assert.equal(replay.interpretation.consentDecision, 'REVOKED', `${label}: debe reconocer rechazo explícito`);
    assert.deepEqual(understanding.candidateFields, {}, `${label}: rechazar no debe inventar datos de perfil`);
  }

  if (expectedIntent === 'SEND_ATTACHMENT') {
    assert.deepEqual(attachment, fixture.inbound.attachment, `${label}: debe conservar metadatos del adjunto`);
    assert.equal(replay.interpretation.consentDecision, null, `${label}: enviar un archivo no equivale a autorizar datos`);
    assert.deepEqual(understanding.candidateFields, {}, `${label}: el nombre del archivo no debe convertirse en dato de perfil`);
  }

  if (expectedIntent === 'ASK_VACANCY_SCHEDULE') {
    assert.equal(turn.question, true, `${label}: el turno debe conservar la pregunta`);
    assert.equal(turn.vacancyInformationRequest, true, `${label}: la pregunta debe reconocerse como información de vacante`);
  }

  if (expectedIntent === 'CORRECT_CANDIDATE_DATA') {
    assert.equal(turn.correction, true, `${label}: el arbitraje debe reconocer la corrección`);
    assert.ok(understanding.corrections.length > 0, `${label}: la comprensión debe conservar evidencia de corrección`);
  }
}

test('el replay determinístico reproduce la interpretación protegida del corpus', async (t) => {
  const entries = loadConversationFixtures();

  for (const { fixture, relativePath } of entries) {
    await t.test(relativePath, async () => {
      assert.equal(
        fixture.policyContext.consentVersion,
        DATA_CONSENT_VERSION,
        `${relativePath}: la versión de consentimiento del fixture debe coincidir con el runtime`
      );

      const replay = await replayFixtureInterpretation(fixture);

      assert.deepEqual(replay.tenantContext, fixture.tenantContext, `${relativePath}: debe preservar TenantContext`);
      assert.deepEqual(
        replay.interpretation,
        fixture.expected.interpretation,
        `${relativePath}: la interpretación real se apartó del comportamiento protegido`
      );
      assertSemanticEvidence(fixture.expected.interpretation.intent, replay, fixture, relativePath);
    });
  }
});

test('el adaptador no devuelve propiedades heredadas del prototipo como intención', async () => {
  const [{ fixture }] = loadConversationFixtures();
  const syntheticFixture = structuredClone(fixture);
  syntheticFixture.providerStubs.aiResult.intent = 'constructor';

  const replay = await replayFixtureInterpretation(syntheticFixture);

  assert.equal(typeof replay.interpretation.intent, 'string');
  assert.equal(replay.interpretation.intent, 'CONSTRUCTOR');
});
