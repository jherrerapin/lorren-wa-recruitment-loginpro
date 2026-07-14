import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVacancyQuestionReply,
  evaluateConsentBoundary,
  isConsentAcceptance,
  isConsentRejection,
  removeHandledMessagesFromWebhook
} from '../src/services/dataConsentGate.js';
import { buildConsentQuestionReply } from '../src/services/consentFaq.js';
import { captureConsentedProfileData } from '../src/services/consentProfileCapture.js';
import {
  buildCandidateDataCollectionMessage,
  getCandidateReadiness
} from '../src/services/readinessGuard.js';
import {
  extractMetaAttributionFields,
  resolveCampaignForReferral
} from '../src/services/campaignAttribution.js';

test('consentimiento reconoce intención natural sin frase única', () => {
  assert.equal(isConsentAcceptance('Sí, estoy de acuerdo'), true);
  assert.equal(isConsentAcceptance('Pueden usar mis datos para la postulación'), true);
  assert.equal(isConsentAcceptance('Doy mi consentimiento, continuemos'), true);
  assert.equal(isConsentRejection('No doy permiso para usar mis datos'), true);
});

test('una pregunta hipotética sobre datos no se registra como autorización', () => {
  assert.equal(isConsentAcceptance('¿Pueden usar mis datos para otra vacante?'), false);
  assert.equal(isConsentAcceptance('¿Qué pasa si autorizo?'), false);
  assert.equal(isConsentRejection('¿Qué pasa si no autorizo?'), false);
  assert.equal(isConsentAcceptance('Sí autorizo, ¿qué sigue?'), true);
});

test('las dudas sobre autorización se responden antes de retomar el consentimiento', () => {
  assert.match(buildConsentQuestionReply('¿Para qué van a usar mis datos?'), /gestionar la postulación/i);
  assert.match(buildConsentQuestionReply('¿Puedo revocar después?'), /revocatoria/i);
  assert.match(buildConsentQuestionReply('¿Qué pasa si no autorizo?'), /no continuaremos/i);
});

test('durante el consentimiento responde con datos de la vacante sin inventar', () => {
  const vacancy = {
    title: 'Líder de Operación',
    city: 'Neiva',
    conditions: 'Salario a convenir y prestaciones de ley',
    requirements: 'Técnico o tecnólogo en logística',
    operationAddress: 'Sector Las Brisas'
  };

  assert.match(buildVacancyQuestionReply(vacancy, '¿Cuánto pagan?'), /Salario a convenir/i);
  assert.match(buildVacancyQuestionReply(vacancy, '¿Dónde queda?'), /Sector Las Brisas/i);
  assert.match(buildVacancyQuestionReply(vacancy, '¿Qué perfil piden?'), /Técnico o tecnólogo/i);
  assert.match(buildVacancyQuestionReply(vacancy, '¿Y si no tengo moto?'), /Técnico o tecnólogo/i);
});

test('un archivo enviado antes del consentimiento queda bloqueado sin depender de una vacante', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: null, vacancyId: null, currentStep: 'MENU', botResumeMode: null },
    { type: 'document', document: { id: 'media-1', filename: 'hoja-de-vida.pdf' } }
  );

  assert.deepEqual(decision, { block: true, reason: 'attachment_before_consent' });
});

test('datos personales enviados espontáneamente se bloquean antes del consentimiento', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: null, vacancyId: null, currentStep: 'MENU', botResumeMode: null },
    { type: 'text', text: { body: 'Me llamo Juan Pérez y mi cédula es 1020304050' } }
  );

  assert.deepEqual(decision, { block: true, reason: 'profile_data_before_consent' });
});

test('un perfil futuro sin vacancyId también exige consentimiento antes de capturar datos', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: null, vacancyId: null, currentStep: 'GREETING_SENT', botResumeMode: 'future_profile_capture' },
    { type: 'text', text: { body: 'Me llamo Juan Pérez' } }
  );

  assert.deepEqual(decision, { block: true, reason: 'capture_mode_without_consent' });
});

test('un candidato con autorización aceptada no vuelve a ser bloqueado por el gate', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: 'ACCEPTED', currentStep: 'COLLECTING_DATA', botResumeMode: null },
    { type: 'document', document: { id: 'media-1', filename: 'hoja-de-vida.pdf' } }
  );

  assert.deepEqual(decision, { block: false, reason: 'consent_already_accepted' });
});

test('un lote conserva los mensajes no manejados cuando otro quedó en consentimiento', () => {
  const body = {
    entry: [{
      changes: [{
        value: {
          messages: [
            { id: 'wamid-blocked', from: '573001111111', type: 'document', timestamp: '1' },
            { id: 'wamid-allowed', from: '573002222222', type: 'text', timestamp: '2', text: { body: 'Quiero información' } }
          ]
        }
      }]
    }]
  };

  removeHandledMessagesFromWebhook(body, [{ id: 'wamid-blocked', from: '573001111111', type: 'document', timestamp: '1' }]);

  assert.deepEqual(body.entry[0].changes[0].value.messages.map((message) => message.id), ['wamid-allowed']);
});

test('después de autorizar solo procesa datos incluidos en el mismo mensaje de autorización', async () => {
  const candidate = {
    id: 'candidate-1',
    documentType: null,
    documentNumber: null
  };
  let persisted = null;
  const prisma = {
    message: {
      findMany: async () => {
        throw new Error('El historial anterior al consentimiento no debe consultarse');
      }
    },
    candidate: {
      update: async ({ data }) => {
        persisted = data;
        return { ...candidate, ...data, dataConsentStatus: 'ACCEPTED' };
      }
    }
  };

  const result = await captureConsentedProfileData({
    prisma,
    candidate,
    vacancy: { city: 'Neiva' },
    currentText: 'Sí autorizo. CC 1020304050'
  });

  assert.equal(result.reason, 'profile_data_captured_from_consent_message');
  assert.equal(persisted.documentType, 'CC');
  assert.equal(persisted.documentNumber, '1020304050');
});

test('los mensajes anteriores al consentimiento no se recuperan después de una aceptación sin datos', async () => {
  const candidate = { id: 'candidate-2', fullName: null };
  let updateCalled = false;
  const prisma = {
    message: {
      findMany: async () => {
        throw new Error('No debe consultar mensajes previos');
      }
    },
    candidate: {
      update: async () => {
        updateCalled = true;
      }
    }
  };

  const result = await captureConsentedProfileData({
    prisma,
    candidate,
    vacancy: { city: 'Bogotá' },
    currentText: 'Sí, autorizo'
  });

  assert.equal(result.reason, 'no_new_profile_data');
  assert.equal(updateCalled, false);
});

test('la recolección permite enviar datos juntos o por partes', () => {
  const message = buildCandidateDataCollectionMessage(
    { fullName: 'Juan Pérez' },
    { id: 'vacancy-1', city: 'Neiva', experienceRequired: 'NO' }
  );

  assert.match(message, /todo junto o por partes/i);
});

test('si declara no tener experiencia no exige tiempo ni descripción', () => {
  const candidate = {
    fullName: 'Juan Pérez',
    documentType: 'CC',
    documentNumber: '123456789',
    age: 30,
    neighborhood: 'Canaima',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    experienceInfo: 'No'
  };
  const readiness = getCandidateReadiness(candidate, {
    id: 'vacancy-1',
    city: 'Neiva',
    experienceRequired: 'YES'
  }, { requireCv: false });

  assert.deepEqual(readiness.missingFields, []);
});

test('atribución prioriza coincidencia exacta y conserva identificadores Meta', () => {
  const campaigns = [
    { id: 'campaign-1', code: '120000001', name: 'Neiva líder', notes: null },
    { id: 'campaign-2', code: 'NEIVA-AUXILIAR', name: 'Neiva auxiliar', notes: null }
  ];
  const message = {
    referral: {
      campaign_id: '120000001',
      campaign_name: 'Campaña Neiva',
      ad_id: 'ad-55',
      ctwa_clid: 'clid-99'
    }
  };

  const resolution = resolveCampaignForReferral(campaigns, message);
  assert.equal(resolution.campaign.id, 'campaign-1');
  assert.equal(resolution.reason, 'exact_campaign_match');
  assert.equal(resolution.matchMode, 'objective_id_exact');
  assert.deepEqual(extractMetaAttributionFields(message), {
    metaCtwaClid: 'clid-99',
    metaAdId: 'ad-55',
    metaCampaignId: '120000001',
    metaCampaignName: 'Campaña Neiva'
  });
});

test('un identificador objetivo gana sobre una coincidencia textual más larga', () => {
  const campaigns = [
    { id: 'campaign-objective', code: '120000001', name: 'Campaña correcta', notes: null },
    { id: 'campaign-text', code: 'LIDER-OPERACION-NEIVA-JULIO-2026', name: 'Líder Operación Neiva Julio 2026', notes: null }
  ];
  const message = {
    referral: {
      campaign_id: '120000001',
      ad_name: 'LIDER-OPERACION-NEIVA-JULIO-2026'
    }
  };

  const resolution = resolveCampaignForReferral(campaigns, message);
  assert.equal(resolution.campaign.id, 'campaign-objective');
  assert.equal(resolution.matchMode, 'objective_id_exact');
});

test('atribución no elige arbitrariamente cuando dos campañas empatan', () => {
  const campaigns = [
    { id: 'campaign-1', code: 'NEIVA-LIDER', name: 'Líder Neiva', notes: null },
    { id: 'campaign-2', code: 'NEIVA-LIDER', name: 'Líder Neiva duplicada', notes: null }
  ];
  const message = { referral: { campaign_name: 'NEIVA-LIDER' } };

  const resolution = resolveCampaignForReferral(campaigns, message);
  assert.equal(resolution.campaign, null);
  assert.equal(resolution.reason, 'ambiguous_campaign_match');
  assert.equal(resolution.matches.length, 2);
});
