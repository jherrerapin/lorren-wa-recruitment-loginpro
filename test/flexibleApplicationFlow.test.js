import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVacancyQuestionReply,
  isConsentAcceptance,
  isConsentRejection
} from '../src/services/dataConsentGate.js';
import { captureConsentedProfileData } from '../src/services/consentProfileCapture.js';
import {
  captureGatedCvDocument,
  isSupportedGatedCvDocument
} from '../src/services/gatedCvCapture.js';
import {
  buildCandidateDataCollectionMessage,
  getCandidateReadiness
} from '../src/services/readinessGuard.js';
import {
  extractMetaAttributionFields,
  resolveCampaignForReferral
} from '../src/services/campaignAttribution.js';

test('consentimiento reconoce intención natural sin frase quemada', () => {
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
  assert.match(buildVacancyQuestionReply(vacancy, '¿Qué requisitos piden?'), /Técnico o tecnólogo/i);
});

test('después de autorizar conserva datos enviados antes y junto con la autorización', async () => {
  const candidate = {
    id: 'candidate-1',
    fullName: null,
    experienceInfo: null,
    experienceTime: null,
    experienceSummary: null
  };
  let persisted = null;
  const prisma = {
    message: {
      findMany: async () => [
        { body: 'Sí autorizo. Tengo 2 años de experiencia en operaciones logísticas y manejo de personal.' },
        { body: 'Vivo en el barrio Canaima' },
        { body: 'Me llamo Juan Carlos Pérez' }
      ]
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
    currentText: 'Sí autorizo. Tengo 2 años de experiencia en operaciones logísticas y manejo de personal.'
  });

  assert.equal(result.reason, 'profile_data_captured_after_consent');
  assert.equal(persisted.fullName, 'Juan Carlos Pérez');
  assert.equal(persisted.neighborhood, 'Canaima');
  assert.equal(persisted.experienceInfo, 'Sí');
  assert.equal(persisted.experienceTime, '2 años');
  assert.match(persisted.experienceSummary, /operaciones logísticas/i);
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

test('solo considera HV anticipada un documento con formato permitido', () => {
  assert.equal(isSupportedGatedCvDocument({
    type: 'document',
    document: { id: 'media-1', mime_type: 'application/pdf', filename: 'hv.pdf' }
  }), true);
  assert.equal(isSupportedGatedCvDocument({
    type: 'image',
    image: { id: 'image-1', mime_type: 'image/jpeg' }
  }), false);
  assert.equal(isSupportedGatedCvDocument({
    type: 'document',
    document: { id: 'media-2', mime_type: 'image/jpeg', filename: 'foto.jpg' }
  }), false);
});

test('captura una HV durante el gate sin alterar el estado conversacional', async () => {
  const stored = [];
  const prisma = {
    candidate: {
      findUnique: async () => ({ cvStorageKey: 'old-key' })
    }
  };
  const message = {
    type: 'document',
    document: { id: 'media-1', mime_type: 'application/pdf', filename: 'hoja-vida.pdf' }
  };

  const result = await captureGatedCvDocument({
    prisma,
    candidateId: 'candidate-1',
    message,
    fetchMetadata: async () => ({ url: 'https://media.test/file' }),
    download: async () => Buffer.from('cv-content'),
    storeCv: async (_prisma, candidateId, buffer, options) => {
      stored.push({ candidateId, buffer: buffer.toString(), options });
    }
  });

  assert.equal(result.captured, true);
  assert.equal(result.filename, 'hoja-vida.pdf');
  assert.deepEqual(stored, [{
    candidateId: 'candidate-1',
    buffer: 'cv-content',
    options: {
      mimeType: 'application/pdf',
      originalName: 'hoja-vida.pdf',
      currentCvStorageKey: 'old-key'
    }
  }]);
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
