import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateMetaAdStatistics,
  buildCandidateRegistrationState,
  buildMetaAdStatistics,
  candidateMatchesAdExactly,
  extractMessagingConversations
} from '../src/services/metaRecruitmentStats.js';

const vacancy = {
  id: 'vac-neiva',
  title: 'Líder de Operación',
  city: 'Neiva',
  experienceRequired: 'YES',
  schedulingEnabled: false
};

function completeCandidate(overrides = {}) {
  return {
    id: 'candidate-1',
    phone: '573000000001',
    fullName: 'Ana Pérez',
    documentType: 'CC',
    documentNumber: '123456789',
    age: 30,
    neighborhood: 'Canaima',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    experienceInfo: 'Sí',
    experienceTime: '2 años',
    experienceSummary: 'Operaciones logísticas y manejo de personal',
    dataConsentStatus: 'ACCEPTED',
    vacancyId: vacancy.id,
    vacancy,
    campaignId: 'campaign-ad-1',
    metaAdId: 'ad-1',
    cvStorageKey: 'candidates/candidate-1/cv.pdf',
    cvOriginalName: 'cv.pdf',
    cvMimeType: 'application/pdf',
    status: 'APROBADO',
    createdAt: new Date('2026-07-10T15:00:00.000Z'),
    interviewBookings: [],
    ...overrides
  };
}

test('registro completo usa consentimiento, campos dinámicos y HV válida', () => {
  const complete = buildCandidateRegistrationState(completeCandidate(), { vacancyId: vacancy.id, vacancy });
  const missingExperience = buildCandidateRegistrationState(
    completeCandidate({ experienceSummary: null, status: 'NUEVO' }),
    { vacancyId: vacancy.id, vacancy }
  );
  const pendingConsent = buildCandidateRegistrationState(
    completeCandidate({ dataConsentStatus: 'PENDING' }),
    { vacancyId: vacancy.id, vacancy }
  );

  assert.equal(complete.complete, true);
  assert.equal(missingExperience.complete, false);
  assert.equal(missingExperience.stageCode, 'DATA_INCOMPLETE');
  assert.match(missingExperience.stage, /en qué tiene experiencia/i);
  assert.equal(pendingConsent.complete, false);
  assert.equal(pendingConsent.stageCode, 'CONSENT_PENDING');
});

test('atribución estadística solo acepta relación directa o ad_id exacto', () => {
  const campaign = { id: 'campaign-ad-1', code: 'ad-1' };
  assert.equal(candidateMatchesAdExactly({ campaignId: 'campaign-ad-1', metaAdId: 'otro' }, campaign), true);
  assert.equal(candidateMatchesAdExactly({ campaignId: null, metaAdId: 'ad-1' }, campaign), true);
  assert.equal(candidateMatchesAdExactly({ campaignId: 'legacy-manual', metaAdId: 'ad-1' }, campaign), true);
  assert.equal(candidateMatchesAdExactly({ campaignId: 'legacy-manual', metaAdId: 'ad-10' }, campaign), false);
  assert.equal(candidateMatchesAdExactly({ campaignId: null, metaAdId: 'ad-10' }, campaign), false);
  assert.equal(candidateMatchesAdExactly({ campaignId: null, metaAdId: null, campaignCodeRaw: 'ad-1 texto' }, campaign), false);
});

test('candidato ligado a una fila heredada se conserva en el anuncio actual por ad_id exacto', () => {
  const campaign = {
    id: 'campaign-ad-1',
    code: 'ad-1',
    name: 'Líder Neiva actual',
    vacancyId: vacancy.id,
    vacancy
  };
  const [metric] = buildMetaAdStatistics({
    campaigns: [campaign],
    candidates: [completeCandidate({ campaignId: 'legacy-manual', metaAdId: 'ad-1' })],
    snapshots: []
  });

  assert.equal(metric.candidatesCount, 1);
  assert.equal(metric.candidates[0].id, 'candidate-1');
});

test('un candidato no se duplica por nombres o tokens parecidos', () => {
  const campaigns = [
    { id: 'campaign-ad-1', code: 'ad-1', name: 'Líder Neiva V1', vacancyId: vacancy.id, vacancy },
    { id: 'campaign-ad-10', code: 'ad-10', name: 'Líder Neiva V10', vacancyId: vacancy.id, vacancy }
  ];
  const metrics = buildMetaAdStatistics({
    campaigns,
    candidates: [completeCandidate({ campaignId: null, metaAdId: 'ad-1' })],
    snapshots: []
  });

  assert.equal(metrics.find((metric) => metric.metaAdId === 'ad-1').candidatesCount, 1);
  assert.equal(metrics.find((metric) => metric.metaAdId === 'ad-10').candidatesCount, 0);
});

test('costo estimado individual distribuye gasto por anuncio y día', () => {
  const campaign = { id: 'campaign-ad-1', code: 'ad-1', name: 'Anuncio 1', vacancyId: vacancy.id, vacancy };
  const candidates = [
    completeCandidate({ interviewBookings: [{ status: 'ATTENDED' }] }),
    completeCandidate({
      id: 'candidate-2',
      phone: '573000000002',
      fullName: 'Carlos Gómez',
      documentNumber: '987654321',
      experienceSummary: null,
      status: 'NUEVO',
      interviewBookings: [{ status: 'NO_SHOW' }]
    })
  ];
  const snapshots = [{
    date: new Date('2026-07-10T00:00:00.000Z'),
    metaAdId: 'ad-1',
    metaAdName: 'Anuncio 1',
    spend: 20000,
    impressions: 1000,
    reach: 800,
    clicks: 20,
    inlineLinkClicks: 10,
    rawActions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }]
  }];

  const [metric] = buildMetaAdStatistics({ campaigns: [campaign], candidates, snapshots, timeZone: 'America/Bogota' });
  assert.equal(metric.spend, 20000);
  assert.equal(metric.candidatesCount, 2);
  assert.equal(metric.completedRegistrations, 1);
  assert.equal(metric.incompleteRegistrations, 1);
  assert.equal(metric.costPerCandidate, 10000);
  assert.equal(metric.costPerCompletedRegistration, 20000);
  assert.equal(metric.candidates[0].estimatedCost, 10000);
  assert.equal(metric.candidates[1].estimatedCost, 10000);
  assert.equal(metric.estimatedIncompleteSpend, 10000);
  assert.equal(metric.metaConversationsStarted, 5);
  assert.equal(metric.scheduled, 2);
  assert.equal(metric.confirmed, 1);
  assert.equal(metric.attended, 1);
  assert.equal(metric.noShow, 1);
  assert.equal(metric.costPerMetaConversation, 4000);
  assert.equal(metric.costPerScheduled, 10000);
  assert.equal(metric.costPerConfirmed, 20000);
  assert.equal(metric.costPerAttended, 20000);
  assert.equal(metric.costPerNoShow, 20000);

  const total = aggregateMetaAdStatistics([metric]);
  assert.equal(total.costPerIncompleteRegistration, 20000);
  assert.equal(total.estimatedIncompleteSpend, 10000);
  assert.equal(total.costPerScheduled, 10000);
  assert.equal(total.costPerAttended, 20000);
  assert.equal(total.noShow, 1);
});

test('inasistencia usa el estado NO_SHOW y no se deduce de confirmados menos asistentes', () => {
  const campaign = { id: 'campaign-ad-1', code: 'ad-1', name: 'Anuncio 1', vacancyId: vacancy.id, vacancy };
  const candidates = [
    completeCandidate({ id: 'confirmed', interviewBookings: [{ status: 'CONFIRMED' }] }),
    completeCandidate({ id: 'no-show', interviewBookings: [{ status: 'NO_SHOW' }] })
  ];

  const [metric] = buildMetaAdStatistics({ campaigns: [campaign], candidates, snapshots: [] });

  assert.equal(metric.scheduled, 2);
  assert.equal(metric.confirmed, 1);
  assert.equal(metric.attended, 0);
  assert.equal(metric.noShow, 1);
});

test('acciones de Meta se suman por coincidencia de conversación iniciada', () => {
  assert.equal(extractMessagingConversations([
    { action_type: 'messaging_conversation_started_7d', value: '2' },
    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' },
    { action_type: 'link_click', value: '10' }
  ]), 5);
});
