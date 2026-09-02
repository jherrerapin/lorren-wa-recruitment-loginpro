import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildVacancyResolutionText,
  hasRecentSameBotDecision,
  resolveVacancyFirstGate,
  VacancyFirstGateAction
} from '../src/services/vacancyFirstGate.js';
import { resolveVacancyFromText } from '../src/services/vacancyResolver.js';
import {
  attributeCandidateCampaignFromMessage,
  extractMetaAttributionFields,
  resolveCampaignForReferral
} from '../src/services/campaignAttribution.js';
import { CAMPAIGN_VACANCY_CONFIRMATION_MODE } from '../src/services/dataConsentGate.js';
import { appendUniqueReplySegment } from '../src/services/replyComposition.js';
import { markConversationMessagesResponded } from '../src/services/conversationMessageRepository.js';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { createInMemoryReplayAdapters } from './conversation-replay/inMemoryAdapters.js';

const manifestPath = fileURLToPath(new URL('./conversation-replay/production-edge-coverage.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const REQUIRED_OBSERVABILITY_KEYS = [
  'source_by_field',
  'rejected_fields',
  'vacancy_resolution',
  'replyKind',
  'reason',
  'engine_loop_guard',
  'respondedAt'
];
const EXPECTED_CASE_IDS = [
  'explicit-labeled-accented-name',
  'name-after-explicit-request',
  'city-role-correction',
  'assigned-candidate-requests-another-vacancy',
  'trusted-metadata-contradicts-ambiguous-text',
  'generated-reply-already-has-follow-up',
  'delivery-before-responded-state-recovery',
  'paused-vacancy-ambiguous-repeat-window'
];

function operation(id, city) {
  return { id, name: `Operación ${city}`, city: { id: `city-${id}`, name: city } };
}

function vacancy(overrides = {}) {
  return {
    id: 'vac-neiva-aux',
    title: 'Auxiliar de cargue y descargue Neiva',
    role: 'Auxiliar de cargue y descargue',
    city: 'Neiva',
    operation: operation('neiva', 'Neiva'),
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

function siberiaVacancy(overrides = {}) {
  return vacancy({
    id: 'vac-siberia-aux',
    title: 'Auxiliar de bodega Siberia',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: operation('bogota-siberia', 'Bogota'),
    operationAddress: 'Parque industrial Siberia',
    ...overrides
  });
}

function prismaFor(vacancies) {
  return {
    vacancy: {
      async findMany() {
        return vacancies;
      },
      async findUnique({ where }) {
        return vacancies.find((item) => item.id === where.id) || null;
      }
    }
  };
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-production-edge-test',
    status: 'EN_PROCESO',
    currentStep: 'COLLECTING_DATA',
    vacancyId: null,
    botResumeMode: null,
    dataConsentStatus: 'PENDING',
    reminderScheduledFor: null,
    reminderState: 'SKIPPED',
    ...overrides
  };
}

async function resolveGate({ text, candidateState, currentVacancy = null, vacancies, vacancyHints = {} }) {
  return resolveVacancyFirstGate({
    prisma: prismaFor(vacancies),
    candidate: candidateState,
    currentVacancy,
    inboundText: text,
    currentStep: candidateState.currentStep,
    recentMessages: [],
    vacancyHints: {
      allVacancies: vacancies,
      activeVacancies: vacancies.filter((item) => item.isActive && item.acceptingApplications),
      ...vacancyHints
    }
  });
}

test('el manifiesto representa los ocho bordes de producción identificados en #423', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.cases.map((item) => item.id), EXPECTED_CASE_IDS);
  assert.equal(new Set(manifest.cases.map((item) => item.id)).size, EXPECTED_CASE_IDS.length);

  const fixtureIds = new Set(loadConversationFixtures().map(({ fixture }) => fixture.id));
  for (const item of manifest.cases) {
    assert.ok(['fixture_replay', 'authority_contract', 'recovery_contract'].includes(item.coverage));
    assert.ok(Array.isArray(item.authorities) && item.authorities.length > 0, `${item.id}: faltan autoridades`);
    assert.deepEqual(Object.keys(item.observability), REQUIRED_OBSERVABILITY_KEYS, `${item.id}: observabilidad incompleta`);
    assert.ok(Array.isArray(item.observability.rejected_fields), `${item.id}: rejected_fields debe ser arreglo`);

    if (item.coverage === 'fixture_replay') {
      assert.ok(fixtureIds.has(item.fixtureId), `${item.id}: fixture no encontrado: ${item.fixtureId}`);
    } else {
      assert.ok(Array.isArray(item.contractTests) && item.contractTests.length > 0, `${item.id}: faltan contratos`);
      for (const relativePath of item.contractTests) {
        const source = readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
        assert.ok(source.trim(), `${item.id}: contrato vacío: ${relativePath}`);
      }
    }
  }
});

test('una corrección actual de ciudad y cargo reemplaza el contexto histórico y ofrece la nueva vacante sin cambiarla todavía', async () => {
  const currentVacancy = vacancy();
  const targetVacancy = vacancy({
    id: 'vac-medellin-lider',
    title: 'Líder de operación Medellín',
    role: 'Líder de operación',
    city: 'Medellin',
    operation: operation('medellin', 'Medellin')
  });
  const text = 'No, en realidad es Medellín para líder de operación';
  const resolutionText = buildVacancyResolutionText(text, [
    { direction: 'INBOUND', body: 'Escribo desde Neiva para auxiliar de cargue y descargue' }
  ]);

  assert.equal(resolutionText, text);
  const decision = await resolveGate({
    text,
    candidateState: candidate({ vacancyId: currentVacancy.id }),
    currentVacancy,
    vacancies: [currentVacancy, targetVacancy]
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_OFFERED');
  assert.equal(decision.vacancyId, targetVacancy.id);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.match(decision.reply, /no cambiará todavía/i);
});

test('una solicitud parcial de otra vacante no reutiliza metadata ni reemplaza la vacante actual', async () => {
  const currentVacancy = vacancy();
  const targetVacancy = vacancy({
    id: 'vac-medellin-lider',
    title: 'Líder de operación Medellín',
    role: 'Líder de operación',
    city: 'Medellin',
    operation: operation('medellin', 'Medellin')
  });

  const decision = await resolveGate({
    text: 'Quiero otra vacante en Medellín',
    candidateState: candidate({ vacancyId: currentVacancy.id }),
    currentVacancy,
    vacancies: [currentVacancy, targetVacancy],
    vacancyHints: { trustedVacancyId: currentVacancy.id, trustedVacancy: currentVacancy }
  });

  assert.equal(decision.reason, 'ASSIGNED_VACANCY_CHANGE_NEEDS_TARGET');
  assert.equal(decision.candidateUpdates, undefined);
  assert.equal(decision.resolution.city, 'Medellin');
  assert.equal(decision.resolution.roleHint, null);
  assert.match(decision.reply, /cargo exacto/i);
});

test('metadata confiable conserva autoridad frente a texto ambiguo contradictorio', async () => {
  const trusted = vacancy({ id: 'vac-meta-neiva' });
  const textMatch = vacancy({
    id: 'vac-text-bogota',
    title: 'Auxiliar de bodega Bogotá',
    role: 'Auxiliar de bodega',
    city: 'Bogota',
    operation: operation('bogota', 'Bogota')
  });

  const decision = await resolveGate({
    text: 'Vi algo de bodega en Bogotá pero no sé bien cuál era',
    candidateState: candidate({ currentStep: 'MENU' }),
    vacancies: [trusted, textMatch],
    vacancyHints: { trustedVacancyId: trusted.id, trustedVacancy: trusted }
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST');
  assert.equal(decision.vacancyId, trusted.id);
  assert.equal(decision.resolution.reason, 'matched_trusted_active_vacancy');
  assert.equal(decision.resolution.source, 'metadata_config');
  assert.equal(decision.resolution.fallback, false);
  assert.match(decision.reply, /Auxiliar de cargue y descargue Neiva/i);
  assert.match(decision.reply, /te interesa continuar/i);
});

test('Click-to-WhatsApp resuelve por source_id exacto del anuncio y no por nombre de campaña', () => {
  const campaigns = [
    {
      id: 'campaign-ad-siberia',
      code: '120000000000001',
      name: 'Anuncio Siberia',
      notes: 'Campaña de operación',
      sourceType: 'META_ADS',
      vacancyId: 'vac-siberia-aux'
    },
    {
      id: 'campaign-ad-other',
      code: '120000000000002',
      name: 'Campaña que coincide por nombre',
      notes: null,
      sourceType: 'META_ADS',
      vacancyId: 'vac-other'
    }
  ];
  const message = {
    referral: {
      source_id: '120000000000001',
      source_type: 'ad',
      campaign_id: 'campaign-objective-id',
      campaign_name: 'Campaña que coincide por nombre',
      ctwa_clid: 'ctwa-test-token'
    }
  };

  const resolution = resolveCampaignForReferral(campaigns, message);
  const metaFields = extractMetaAttributionFields(message);

  assert.equal(resolution.campaign.id, 'campaign-ad-siberia');
  assert.equal(resolution.matchMode, 'meta_source_ad_id_exact');
  assert.equal(metaFields.metaAdId, '120000000000001');
  assert.equal(metaFields.metaCtwaClid, 'ctwa-test-token');
});

test('Click-to-WhatsApp falla cerrado si source_id no corresponde al anuncio exacto aunque otros metadatos coincidan', () => {
  const campaigns = [{
    id: 'campaign-wrong-ad',
    code: 'campaign-objective-id',
    name: 'Campaña Siberia',
    notes: 'Siberia',
    sourceType: 'META_ADS',
    vacancyId: 'vac-wrong'
  }];
  const message = {
    referral: {
      source_id: '120000000009999',
      source_type: 'ad',
      campaign_id: 'campaign-objective-id',
      campaign_name: 'Campaña Siberia',
      headline: 'Auxiliar de bodega Siberia'
    }
  };

  const resolution = resolveCampaignForReferral(campaigns, message);

  assert.equal(resolution.campaign, null);
  assert.equal(resolution.reason, 'objective_metadata_without_exact_campaign_match');
  assert.deepEqual(resolution.matches, []);
});

test('source_id de una publicación no se persiste como metaAdId ni puede seleccionar un anuncio', () => {
  const campaigns = [{
    id: 'campaign-ad',
    code: '120000000000003',
    name: 'Anuncio operativo',
    sourceType: 'META_ADS',
    vacancyId: 'vac-one'
  }];
  const message = {
    referral: {
      source_id: '120000000000003',
      source_type: 'post',
      headline: 'Publicación orgánica'
    }
  };

  const fields = extractMetaAttributionFields(message);
  const resolution = resolveCampaignForReferral(campaigns, message);

  assert.equal(fields.metaAdId, undefined);
  assert.equal(resolution.campaign, null);
  assert.equal(resolution.reason, 'objective_metadata_without_exact_campaign_match');
});

test('atribución CTWA persiste anuncio y vacante exactos dejando confirmación pendiente', async () => {
  const updates = [];
  const prisma = {
    candidate: {
      async findUnique() {
        return {
          id: 'candidate-ctwa-test',
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
      },
      async update(args) {
        updates.push(args);
        return { id: args.where.id, ...args.data };
      }
    },
    campaign: {
      async findMany() {
        return [{
          id: 'campaign-ad-siberia',
          code: '120000000000004',
          name: 'Anuncio Siberia',
          notes: null,
          sourceType: 'META_ADS',
          vacancyId: 'vac-siberia-aux'
        }];
      }
    }
  };
  const message = {
    referral: {
      source_id: '120000000000004',
      source_type: 'ad',
      ctwa_clid: 'ctwa-test-assignment'
    }
  };

  const result = await attributeCandidateCampaignFromMessage(prisma, 'candidate-ctwa-test', message);

  assert.equal(result.attributed, true);
  assert.equal(result.vacancyId, 'vac-siberia-aux');
  assert.equal(result.matchMode, 'meta_source_ad_id_exact');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.campaignId, 'campaign-ad-siberia');
  assert.equal(updates[0].data.vacancyId, 'vac-siberia-aux');
  assert.equal(updates[0].data.botResumeMode, CAMPAIGN_VACANCY_CONFIRMATION_MODE);
  assert.equal(updates[0].data.metaAdId, '120000000000004');
});

test('residencia en Madrid habilita una vacante compatible de Siberia sin convertir Madrid en ciudad de la vacante', async () => {
  const target = siberiaVacancy();
  const resolution = await resolveVacancyFromText(null, 'Soy de Madrid y me interesa auxiliar de bodega', {
    activeVacancies: [target],
    allVacancies: [target]
  });

  assert.equal(resolution.resolved, true);
  assert.equal(resolution.vacancy.id, target.id);
  assert.equal(resolution.city, 'Bogota');
  assert.equal(resolution.residenceLocation, 'Madrid');
});

test('una búsqueda explícita en Medellín no cruza hacia la vacante de Siberia', async () => {
  const target = siberiaVacancy();
  const resolution = await resolveVacancyFromText(null, 'Busco vacantes de auxiliar de bodega en Medellín', {
    activeVacancies: [target],
    allVacancies: [target]
  });

  assert.equal(resolution.resolved, false);
  assert.equal(resolution.vacancy, null);
  assert.equal(resolution.city, 'Medellin');
  assert.equal(resolution.reason, 'city_without_active_vacancies');
});

test('residencia sin cargo pide el anuncio de forma contextual y no como catálogo de vacantes', async () => {
  const target = siberiaVacancy();
  const decision = await resolveGate({
    text: 'Soy de Madrid',
    candidateState: candidate({ currentStep: 'GREETING_SENT' }),
    vacancies: [target]
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'RESIDENCE_CAPTURED_VACANCY_NEEDED');
  assert.match(decision.reply, /cargo.*anuncio|anuncio.*cargo/i);
  assert.doesNotMatch(decision.reply, /qué vacante.*te interesa|para qué vacante.*interesad/i);
  assert.doesNotMatch(decision.reply, /no tengo vacantes activas/i);
});

test('el compositor no duplica un seguimiento que la respuesta generada ya contiene', () => {
  const generated = 'Estoy validando tus datos. Envíame tu HV como archivo PDF para cerrar el registro.';
  const deterministicFollowUp = 'Para continuar necesito que adjuntes tu hoja de vida como archivo PDF, DOC o DOCX.';

  assert.equal(appendUniqueReplySegment(generated, deterministicFollowUp), generated);
});

test('la entrega exige outbox persistido y respondedAt se actualiza mediante su repositorio explícito', async () => {
  const [{ fixture }] = loadConversationFixtures();
  const adapters = createInMemoryReplayAdapters(fixture);
  const candidateId = fixture.initialState.candidate.candidateId;
  const idempotencyKey = 'test-production-edge-outbox:reply:v1';
  const body = 'Respuesta comprometida de prueba';

  assert.throws(
    () => adapters.deliverOutbound({
      tenantContext: fixture.tenantContext,
      requestedCandidateId: candidateId,
      idempotencyKey,
      body
    }),
    /outbound_not_persisted:/
  );

  assert.equal(adapters.persistOutbound({
    tenantContext: fixture.tenantContext,
    policyContext: fixture.policyContext,
    requestedCandidateId: candidateId,
    idempotencyKey,
    body
  }), true);
  assert.equal(adapters.deliverOutbound({
    tenantContext: fixture.tenantContext,
    requestedCandidateId: candidateId,
    idempotencyKey,
    body
  }), true);

  let updateManyArgs = null;
  const respondedAt = new Date('2026-07-28T02:00:00.000Z');
  const result = await markConversationMessagesResponded({
    message: {
      async updateMany(args) {
        updateManyArgs = args;
        return { count: 2 };
      }
    }
  }, {
    messageIds: ['test-inbound-1', 'test-inbound-2'],
    respondedAt
  });

  assert.equal(result.updated, 2);
  assert.deepEqual(updateManyArgs.where.id.in, ['test-inbound-1', 'test-inbound-2']);
  assert.equal(updateManyArgs.data.respondedAt.toISOString(), respondedAt.toISOString());
});

test('la misma decisión de vacante se suprime dentro de diez minutos y vuelve a ser elegible fuera de la ventana', () => {
  const now = Date.now();
  const common = {
    direction: 'OUTBOUND',
    rawPayload: {
      actor: 'BOT',
      source: 'vacancy_first_gate',
      replyKind: 'INACTIVE_VACANCY_FUTURE_PROFILE_OFFER',
      reason: 'INACTIVE_VACANCY'
    }
  };

  assert.equal(hasRecentSameBotDecision({
    recentMessages: [{ ...common, createdAt: new Date(now - 5 * 60 * 1000) }],
    replyKind: common.rawPayload.replyKind,
    reason: common.rawPayload.reason,
    windowMinutes: 10
  }), true);

  assert.equal(hasRecentSameBotDecision({
    recentMessages: [{ ...common, createdAt: new Date(now - 11 * 60 * 1000) }],
    replyKind: common.rawPayload.replyKind,
    reason: common.rawPayload.reason,
    windowMinutes: 10
  }), false);
});
