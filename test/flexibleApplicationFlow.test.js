import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPAIGN_VACANCY_CONFIRMATION_MODE,
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
  attributeCandidateCampaignFromMessage,
  extractMetaAttributionFields,
  resolveCampaignForReferral
} from '../src/services/campaignAttribution.js';
import { consolidateTextMessages } from '../src/services/multiline.js';
import { conversationUnderstanding } from '../src/services/conversationUnderstanding.js';
import { resolveVacancyFromText } from '../src/services/vacancyResolver.js';
import {
  resolveVacancyFirstGate,
  VacancyFirstGateAction
} from '../src/services/vacancyFirstGate.js';

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
    { type: 'text', text: { body: 'Me llamo Persona Prueba y mi cédula es 1020304050' } }
  );

  assert.deepEqual(decision, { block: true, reason: 'profile_data_before_consent' });
});

test('un perfil futuro sin vacancyId también exige consentimiento antes de capturar datos', () => {
  const decision = evaluateConsentBoundary(
    { dataConsentStatus: null, vacancyId: null, currentStep: 'GREETING_SENT', botResumeMode: 'future_profile_capture' },
    { type: 'text', text: { body: 'Me llamo Persona Prueba' } }
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
            { id: 'wamid-blocked', from: 'TEST-PHONE-1', type: 'document', timestamp: '1' },
            { id: 'wamid-allowed', from: 'TEST-PHONE-2', type: 'text', timestamp: '2', text: { body: 'Quiero información' } }
          ]
        }
      }]
    }]
  };

  removeHandledMessagesFromWebhook(body, [{ id: 'wamid-blocked', from: 'TEST-PHONE-1', type: 'document', timestamp: '1' }]);

  assert.deepEqual(body.entry[0].changes[0].value.messages.map((message) => message.id), ['wamid-allowed']);
});

test('después de autorizar solo procesa datos incluidos en el mismo mensaje de autorización', async () => {
  const candidate = {
    id: 'candidate-1',
    dataConsentStatus: 'ACCEPTED',
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
      updateMany: async ({ where, data }) => {
        assert.equal(where.id, candidate.id);
        assert.equal(where.dataConsentStatus, 'ACCEPTED');
        persisted = data;
        return { count: 1 };
      },
      findUnique: async () => ({
        ...candidate,
        ...persisted,
        dataConsentStatus: 'ACCEPTED'
      })
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
  const candidate = { id: 'candidate-2', dataConsentStatus: 'ACCEPTED', fullName: null };
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
    { fullName: 'Persona Prueba' },
    { id: 'vacancy-1', city: 'Neiva', experienceRequired: 'NO' }
  );

  assert.match(message, /todo junto o por partes/i);
});

test('si declara no tener experiencia no exige tiempo ni descripción', () => {
  const candidate = {
    fullName: 'Persona Prueba',
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

test('CTWA prioriza source_id exacto del anuncio y conserva identificadores Meta', () => {
  const campaigns = [
    { id: 'campaign-1', code: 'ad-55', name: 'Neiva líder', notes: null },
    { id: 'campaign-2', code: 'NEIVA-AUXILIAR', name: 'Neiva auxiliar', notes: null }
  ];
  const message = {
    referral: {
      source_id: 'ad-55',
      source_type: 'ad',
      campaign_id: '120000001',
      campaign_name: 'Campaña Neiva',
      ctwa_clid: 'clid-99'
    }
  };

  const resolution = resolveCampaignForReferral(campaigns, message);
  assert.equal(resolution.campaign.id, 'campaign-1');
  assert.equal(resolution.reason, 'exact_campaign_match');
  assert.equal(resolution.matchMode, 'meta_source_ad_id_exact');
  assert.deepEqual(extractMetaAttributionFields(message), {
    metaCtwaClid: 'clid-99',
    metaAdId: 'ad-55',
    metaCampaignId: '120000001',
    metaCampaignName: 'Campaña Neiva'
  });
});

test('source_id exacto gana sobre una coincidencia textual más larga', () => {
  const campaigns = [
    { id: 'campaign-objective', code: 'ad-objective', name: 'Campaña correcta', notes: null },
    { id: 'campaign-text', code: 'LIDER-OPERACION-NEIVA-JULIO-2026', name: 'Líder Operación Neiva Julio 2026', notes: null }
  ];
  const message = {
    referral: {
      source_id: 'ad-objective',
      source_type: 'ad',
      campaign_id: '120000001',
      ad_name: 'LIDER-OPERACION-NEIVA-JULIO-2026'
    }
  };

  const resolution = resolveCampaignForReferral(campaigns, message);
  assert.equal(resolution.campaign.id, 'campaign-objective');
  assert.equal(resolution.matchMode, 'meta_source_ad_id_exact');
});

test('un ad_id desconocido no degrada a una campaña de nombre parecido', () => {
  const campaigns = [
    {
      id: 'campaign-wrong',
      code: 'ad-registered',
      name: 'Líder Operación Neiva Julio 2026',
      notes: 'Anuncio sincronizado desde Meta Ads'
    }
  ];
  const message = {
    referral: {
      ad_id: 'ad-unknown',
      campaign_id: 'campaign-unknown',
      ad_name: 'Líder Operación Neiva Julio 2026'
    }
  };

  const resolution = resolveCampaignForReferral(campaigns, message);
  assert.equal(resolution.campaign, null);
  assert.equal(resolution.reason, 'objective_metadata_without_exact_campaign_match');
  assert.deepEqual(resolution.matches, []);
});

test('source_id sin source_type queda como trazabilidad y no selecciona una vacante', () => {
  const campaigns = [{
    id: 'campaign-ambiguous-source',
    code: 'ad-ambiguous-source',
    name: 'Anuncio sincronizado',
    notes: null,
    vacancyId: 'vacancy-ambiguous-source'
  }];
  const message = { referral: { source_id: 'ad-ambiguous-source' } };

  const resolution = resolveCampaignForReferral(campaigns, message);
  const fields = extractMetaAttributionFields(message);

  assert.equal(resolution.campaign, null);
  assert.equal(resolution.reason, 'objective_metadata_without_exact_campaign_match');
  assert.equal(fields.metaAdId, undefined);
});

test('source_id de una publicación no se interpreta como AD_ID', () => {
  const campaigns = [{
    id: 'campaign-post-source',
    code: 'post-source-id',
    name: 'Anuncio sincronizado',
    notes: null,
    vacancyId: 'vacancy-post-source'
  }];
  const message = { referral: { source_id: 'post-source-id', source_type: 'post' } };

  const resolution = resolveCampaignForReferral(campaigns, message);
  const fields = extractMetaAttributionFields(message);

  assert.equal(resolution.campaign, null);
  assert.equal(resolution.reason, 'objective_metadata_without_exact_campaign_match');
  assert.equal(fields.metaAdId, undefined);
});

test('una coincidencia descriptiva parcial no asigna campaña', () => {
  const campaigns = [
    {
      id: 'campaign-1',
      code: 'NEIVA-LIDER-JULIO-2026',
      name: 'Líder Operación Neiva Julio 2026',
      notes: null
    }
  ];
  const message = {
    referral: {
      ad_name: 'Líder Operación Neiva'
    }
  };

  const resolution = resolveCampaignForReferral(campaigns, message);
  assert.equal(resolution.campaign, null);
  assert.equal(resolution.reason, 'no_campaign_match');
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

function createCampaignAttributionPrisma({ candidate, campaigns }) {
  const updates = [];
  return {
    updates,
    prisma: {
      candidate: {
        async findUnique() {
          return { ...candidate };
        },
        async update(args) {
          updates.push(args);
          return { id: args.where.id, ...args.data };
        }
      },
      campaign: {
        async findMany() {
          return campaigns;
        }
      }
    }
  };
}

test('atribución CTWA inicial persiste el anuncio exacto y deja confirmación pendiente', async () => {
  const previous = {
    id: 'candidate-new-ctwa',
    campaignId: null,
    vacancyId: null,
    sourceType: 'UNKNOWN',
    campaignCodeRaw: null,
    botResumeMode: null,
    metaCtwaClid: null,
    metaAdId: null,
    metaCampaignId: null,
    metaCampaignName: null
  };
  const target = {
    id: 'campaign-siberia',
    code: 'ad-siberia',
    name: 'Anuncio Siberia',
    notes: null,
    sourceType: 'META_ADS',
    vacancyId: 'vac-siberia'
  };
  const { prisma, updates } = createCampaignAttributionPrisma({ candidate: previous, campaigns: [target] });

  const result = await attributeCandidateCampaignFromMessage(prisma, previous.id, {
    referral: {
      source_id: target.code,
      source_type: 'ad',
      ctwa_clid: 'clid-siberia'
    }
  });

  assert.equal(result.attributed, true);
  assert.equal(result.campaignId, target.id);
  assert.equal(result.vacancyId, target.vacancyId);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.campaignId, target.id);
  assert.equal(updates[0].data.vacancyId, target.vacancyId);
  assert.equal(updates[0].data.metaAdId, target.code);
  assert.equal(updates[0].data.botResumeMode, CAMPAIGN_VACANCY_CONFIRMATION_MODE);
});

test('un candidato con vacante persistida no es reatribuido antes de confirmar otro anuncio', async () => {
  const previous = {
    id: 'candidate-returning-ctwa',
    campaignId: 'campaign-old',
    vacancyId: 'vac-old',
    sourceType: 'META_ADS',
    campaignCodeRaw: 'old-ad',
    botResumeMode: null,
    metaCtwaClid: 'clid-old',
    metaAdId: 'ad-old',
    metaCampaignId: null,
    metaCampaignName: null
  };
  const target = {
    id: 'campaign-siberia',
    code: 'ad-siberia',
    name: 'Anuncio Siberia',
    notes: null,
    sourceType: 'META_ADS',
    vacancyId: 'vac-siberia'
  };
  const { prisma, updates } = createCampaignAttributionPrisma({ candidate: previous, campaigns: [target] });

  const result = await attributeCandidateCampaignFromMessage(prisma, previous.id, {
    referral: {
      source_id: target.code,
      source_type: 'ad',
      ctwa_clid: 'clid-siberia'
    }
  });

  assert.equal(result.attributed, false);
  assert.equal(result.reason, 'candidate_already_attributed');
  assert.equal(result.campaignId, previous.campaignId);
  assert.equal(result.vacancyId, previous.vacancyId);
  assert.equal(updates.some((entry) => 'campaignId' in entry.data || 'vacancyId' in entry.data), false);
});

test('el texto consolidado enviado a comprensión contiene solo lo escrito por el candidato', async () => {
  const candidateText = 'Hola, quisiera información';
  const consolidated = consolidateTextMessages([{
    body: candidateText,
    rawPayload: {
      lorrenAdContext: {
        adId: 'TEST-AD-LEGACY',
        mapped: true,
        text: 'Ciudad: Ibague | Vacante: Auxiliar de cargue y descargue | Zona: Aeropuerto'
      }
    }
  }]);

  assert.equal(consolidated, candidateText);
  assert.doesNotMatch(consolidated, /Ibague|cargue|Aeropuerto/i);

  const understanding = await conversationUnderstanding(consolidated, {
    aiResult: { status: 'disabled', intent: null, parsedFields: {} },
    runtime: {
      localParsedData: {},
      engineFields: {},
      engineUsage: {},
      fallbackIntent: 'greeting'
    },
    context: {}
  });

  assert.equal(understanding.turnInterpretation.cityHint, null);
  assert.equal(understanding.turnInterpretation.roleHint, null);
});

function operation(id, city, name = `Operación ${city}`) {
  return { id, name, city: { id: `city-${id}`, name: city } };
}

function vacancy(overrides = {}) {
  return {
    id: 'vac-siberia-aux',
    title: 'Auxiliar de bodega Siberia',
    role: 'Auxiliar de bodega',
    roleDescription: 'Apoyo operativo de bodega',
    city: 'Bogota',
    operation: operation('siberia', 'Bogota', 'Operación Siberia'),
    operationAddress: 'Parque industrial Siberia',
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

const RESIDENCE_CASES = [
  ['Estoy en Soacha y me interesa auxiliar de bodega', 'soacha'],
  ['Me encuentro en Funza y me interesa auxiliar de bodega', 'funza'],
  ['Vivo en Mosquera y me interesa auxiliar de bodega', 'mosquera'],
  ['Soy de Madrid y me interesa auxiliar de bodega', 'madrid']
];

test('las formas naturales de residencia no se convierten en ciudad objetivo de la vacante', async () => {
  const target = vacancy();
  for (const [text, expectedResidence] of RESIDENCE_CASES) {
    const resolution = await resolveVacancyFromText(null, text, {
      activeVacancies: [target],
      allVacancies: [target]
    });

    assert.equal(resolution.resolved, true, text);
    assert.equal(resolution.vacancy.id, target.id, text);
    assert.equal(resolution.city, 'Bogota', text);
    assert.equal(String(resolution.residenceLocation || '').toLowerCase(), expectedResidence, text);
    assert.notEqual(resolution.reason, 'city_without_active_vacancies', text);
  }
});

test('una búsqueda explícita en Medellín sigue sin cruzarse hacia Siberia', async () => {
  const target = vacancy();
  const resolution = await resolveVacancyFromText(null, 'Busco vacantes de auxiliar de bodega en Medellín', {
    activeVacancies: [target],
    allVacancies: [target]
  });

  assert.equal(resolution.resolved, false);
  assert.equal(resolution.vacancy, null);
  assert.equal(resolution.city, 'Medellin');
  assert.equal(resolution.reason, 'city_without_active_vacancies');
});

test('residencia Soacha y cargo no se cruzan globalmente a una vacante de Cali', async () => {
  const cali = vacancy({
    id: 'vac-cali-aux',
    title: 'Auxiliar de bodega Cali',
    city: 'Cali',
    operation: operation('cali', 'Cali')
  });
  const text = 'Estoy en Soacha y me interesa auxiliar de bodega';
  const resolution = await resolveVacancyFromText(null, text, {
    activeVacancies: [cali],
    allVacancies: [cali]
  });

  assert.equal(resolution.resolved, false);
  assert.equal(resolution.vacancy, null);
  assert.equal(resolution.city, null);
  assert.equal(String(resolution.residenceLocation || '').toLowerCase(), 'soacha');
  assert.equal(resolution.reason, 'residence_without_compatible_vacancy');
});

test('residencia y cargo conocidos piden solo el dato faltante sin reiniciar la conversación', async () => {
  const cali = vacancy({
    id: 'vac-cali-aux',
    title: 'Auxiliar de bodega Cali',
    city: 'Cali',
    operation: operation('cali', 'Cali')
  });
  const candidate = {
    id: 'candidate-residence-target',
    status: 'NUEVO',
    currentStep: 'GREETING_SENT',
    vacancyId: null,
    botResumeMode: null,
    dataConsentStatus: 'PENDING',
    reminderScheduledFor: null,
    reminderState: 'SKIPPED'
  };
  const prisma = {
    vacancy: {
      async findMany() { return [cali]; },
      async findUnique({ where }) { return where.id === cali.id ? cali : null; }
    }
  };

  const decision = await resolveVacancyFirstGate({
    prisma,
    candidate,
    currentVacancy: null,
    inboundText: 'Estoy en Soacha y me interesa auxiliar de bodega',
    currentStep: candidate.currentStep,
    recentMessages: [],
    vacancyHints: { allVacancies: [cali], activeVacancies: [cali] }
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'RESIDENCE_AND_ROLE_CAPTURED_TARGET_NEEDED');
  assert.doesNotMatch(decision.reply, /^Hola\b/i);
  assert.doesNotMatch(decision.reply, /desde qué ciudad|qué ciudad/i);
  assert.doesNotMatch(decision.reply, /qué cargo viste|qué cargo te interesa/i);
  assert.match(decision.reply, /operación|anuncio|zona|dónde quieres aplicar/i);
});