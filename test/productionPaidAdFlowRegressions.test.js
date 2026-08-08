import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVacancyFirstGate, VacancyFirstGateAction } from '../src/services/vacancyFirstGate.js';
import { isAffirmativeVacancyConfirmation, APPLICATION_INTEREST_PENDING_MODE, DATA_CONSENT_PENDING_MODE } from '../src/services/dataConsentGate.js';
import { isApplicationFollowUpQuestion } from '../src/routes/webhook.js';
import { resolveCampaignForReferral } from '../src/services/campaignAttribution.js';
import { getMultilineWindowMs } from '../src/services/multiline.js';

const vacancy = {
  id: 'vac-neiva-leader',
  title: 'Líder de Operación',
  role: 'Líder de Operación',
  city: 'Neiva',
  roleDescription: 'Liderar y administrar equipos de trabajo',
  operationAddress: 'Sector Las Brisas, cerca a la terminal de Neiva',
  requirements: 'Técnico o tecnólogo en Logística y mínimo un año de experiencia',
  conditions: 'Salario a convenir, turnos rotativos y prestaciones de ley',
  isActive: true,
  acceptingApplications: true,
  schedulingEnabled: false,
  operation: { id: 'op-neiva', name: 'Operación Neiva', city: { id: 'city-neiva', name: 'Neiva' } }
};

function candidate(overrides = {}) {
  return {
    id: 'cand-production',
    status: 'NUEVO',
    currentStep: 'GREETING_SENT',
    vacancyId: null,
    botResumeMode: null,
    dataConsentStatus: 'PENDING',
    ...overrides
  };
}

test('producción: vacante resuelta entrega información antes de preguntar interés', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate(),
    currentVacancy: null,
    inboundText: 'Neiva líder de operaciones',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'ACTIVE_VACANCY_RESOLVED_AWAIT_INTEREST');
  assert.match(decision.reply, /Liderar y administrar equipos/i);
  assert.match(decision.reply, /Sector Las Brisas/i);
  assert.match(decision.reply, /Técnico o tecnólogo/i);
  assert.match(decision.reply, /Salario a convenir/i);
  assert.match(decision.reply, /te interesa continuar/i);
});

test('producción: Esa si se reconoce como confirmación natural de la vacante', () => {
  assert.equal(isAffirmativeVacancyConfirmation('Esa si'), true);
  assert.equal(isAffirmativeVacancyConfirmation('Esta sí'), true);
  assert.equal(isAffirmativeVacancyConfirmation('Sí, esa es'), true);
});

test('defensa: confirmar vacante jamás pide datos antes del consentimiento', async () => {
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: candidate({ vacancyId: vacancy.id, botResumeMode: APPLICATION_INTEREST_PENDING_MODE }),
    currentVacancy: vacancy,
    inboundText: 'Esa si',
    currentStep: 'GREETING_SENT',
    recentMessages: [],
    vacancyHints: { allVacancies: [vacancy], activeVacancies: [vacancy] }
  });
  assert.equal(decision.reason, 'ACTIVE_VACANCY_CONFIRMED_AWAIT_CONSENT');
  assert.match(decision.reply, /autorización|autorizas/i);
  assert.doesNotMatch(decision.reply, /compárteme.*documento|compárteme.*edad/i);
  assert.match(String(decision.candidateUpdates.botResumeMode), new RegExp(`^${DATA_CONSENT_PENDING_MODE}`));
});

test('producción: DONE entiende quiero saber sobre mi proceso', () => {
  assert.equal(isApplicationFollowUpQuestion('¡Hola! Quiero saber sobre mi proceso'), true);
  assert.equal(isApplicationFollowUpQuestion('¿Cómo va mi proceso?'), true);
  assert.equal(isApplicationFollowUpQuestion('Quisiera saber de mi postulación'), true);
});

test('Meta: campaign_name exacto puede resolver IDs nuevos sin usar ad_name difuso', () => {
  const campaigns = [
    { id: 'camp-neiva', code: 'INTERNO-NEIVA', name: 'Líder Operación Neiva Agosto 2026' },
    { id: 'camp-otra', code: 'INTERNO-OTRA', name: 'Otra campaña' }
  ];
  const exact = resolveCampaignForReferral(campaigns, { referral: {
    campaign_id: '120999999999', ad_id: '238999999999', campaign_name: 'Líder Operación Neiva Agosto 2026', ad_name: 'Anuncio cualquiera'
  }});
  assert.equal(exact.campaign.id, 'camp-neiva');
  assert.equal(exact.matchMode, 'campaign_name_exact_with_objective_metadata');

  const unsafe = resolveCampaignForReferral(campaigns, { referral: {
    campaign_id: '120999999999', ad_id: '238999999999', ad_name: 'Líder Operación Neiva Agosto 2026'
  }});
  assert.equal(unsafe.campaign, null);
  assert.equal(unsafe.reason, 'objective_metadata_without_exact_campaign_match');
});

test('latencia: configuración heredada de 60s queda limitada a máximo 20s', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousReasoning = process.env.LORREN_REASONING_WINDOW_MS;
  process.env.NODE_ENV = 'production';
  process.env.LORREN_REASONING_WINDOW_MS = '60000';
  try {
    assert.equal(getMultilineWindowMs(), 20000);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousReasoning === undefined) delete process.env.LORREN_REASONING_WINDOW_MS; else process.env.LORREN_REASONING_WINDOW_MS = previousReasoning;
  }
});
