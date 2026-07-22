import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { installOpenAIMock } from './helpers/mockOpenAI.js';
import { baseOperations, conversationCases } from './fixtures/conversationCases.js';
import { resolveVacancyFromText } from '../src/services/vacancyResolver.js';
import { resolveVacancyFirstGate, VacancyFirstGateAction } from '../src/services/vacancyFirstGate.js';

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.USE_CONVERSATION_ENGINE = 'true';
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';

const { processText } = await import('../src/routes/webhook.js');
const { createDebugTrace } = await import('../src/services/debugTrace.js');

const targetCase = conversationCases.find(
  (conversationCase) => conversationCase.id === 'inactive-vacancy-offers-registration-for-future-openings'
);

function targetVacancies() {
  assert.ok(targetCase, 'el escenario objetivo debe existir');
  const active = targetCase.vacancies.find((vacancy) => vacancy.id === 'vac-post');
  const inactive = targetCase.vacancies.find((vacancy) => vacancy.id === 'vac-iba-inactive');
  assert.ok(active, 'debe existir la vacante activa genérica');
  assert.ok(inactive, 'debe existir la vacante inactiva específica');
  return { active, inactive };
}

test('vacante inactiva específica vence coincidencia activa genérica', async () => {
  const { active, inactive } = targetVacancies();
  const resolution = await resolveVacancyFromText(null, targetCase.steps[0], {
    activeVacancies: [active],
    allVacancies: [active, inactive]
  });

  assert.equal(resolution.resolved, true);
  assert.equal(resolution.vacancy.id, inactive.id);
  assert.equal(resolution.reason, 'matched_inactive_vacancy');
});

test('empate de cargo conserva prioridad de la vacante activa', async () => {
  const { inactive } = targetVacancies();
  const activeTwin = {
    ...inactive,
    id: 'vac-iba-coord-active',
    acceptingApplications: true,
    isActive: true,
    updatedAt: new Date('2026-07-22T21:00:00.000Z')
  };

  const resolution = await resolveVacancyFromText(null, targetCase.steps[0], {
    activeVacancies: [activeTwin],
    allVacancies: [inactive, activeTwin]
  });

  assert.equal(resolution.resolved, true);
  assert.equal(resolution.vacancy.id, activeTwin.id);
  assert.equal(resolution.reason, 'matched_active_vacancy');
});

test('cargo genérico operaciones no abre una vacante inactiva específica', async () => {
  const { active, inactive } = targetVacancies();
  const resolution = await resolveVacancyFromText(null, 'Estoy en Ibague y me interesa operaciones', {
    activeVacancies: [active],
    allVacancies: [active, inactive]
  });

  assert.equal(resolution.resolved, true);
  assert.equal(resolution.vacancy.id, active.id);
  assert.equal(resolution.reason, 'matched_active_vacancy');
});

test('una solicitud de otra ciudad nunca cruza a la vacante inactiva', async () => {
  const { active, inactive } = targetVacancies();
  const resolution = await resolveVacancyFromText(null, 'Estoy en Bogota y me interesa coordinador de operaciones', {
    activeVacancies: [active],
    allVacancies: [active, inactive]
  });

  assert.equal(resolution.resolved, false);
  assert.equal(resolution.city, 'Bogota');
  assert.equal(resolution.vacancy, null);
});

test('la compuerta incluye vacancyId en la decisión de vacante inactiva', async () => {
  const { active, inactive } = targetVacancies();
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: { ...targetCase.candidate },
    currentVacancy: null,
    inboundText: targetCase.steps[0],
    currentStep: targetCase.candidate.currentStep,
    recentMessages: [],
    vacancyHints: {
      activeVacancies: [active],
      allVacancies: [active, inactive]
    }
  });

  assert.equal(decision.action, VacancyFirstGateAction.INACTIVE_VACANCY_REPLY);
  assert.equal(decision.vacancy.id, inactive.id);
  assert.equal(decision.candidateUpdates.vacancyId, inactive.id);
  assert.equal(decision.candidateUpdates.currentStep, 'GREETING_SENT');
});

test('flujo integral asocia la inactiva y ofrece registro para futura apertura', async () => {
  assert.ok(targetCase, 'el escenario objetivo debe existir');
  const candidate = { ...targetCase.candidate };
  const prisma = createMockPrisma({
    candidates: [candidate],
    messages: [],
    vacancies: targetCase.vacancies,
    operations: targetCase.operations || baseOperations,
    interviewSlots: [],
    interviewBookings: []
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    const body = targetCase.steps[0];
    const createdAt = new Date('2026-07-22T22:00:00.000Z');
    await prisma.message.create({
      data: {
        candidateId: candidate.id,
        direction: 'INBOUND',
        messageType: 'TEXT',
        body,
        rawPayload: { body, source: 'candidate' },
        createdAt
      }
    });
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { lastInboundAt: createdAt }
    });

    const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    const debugTrace = createDebugTrace({
      phone: candidate.phone,
      currentStepBefore: freshCandidate.currentStep
    });
    await processText(prisma, freshCandidate, candidate.phone, body, debugTrace, {});

    const finalCandidate = prisma.state.candidates[0];
    const lastReply = whatsappMock.sentMessages.at(-1)?.body || '';
    assert.equal(finalCandidate.vacancyId, 'vac-iba-inactive');
    assert.equal(finalCandidate.currentStep, 'GREETING_SENT');
    assert.match(lastReply, /no esta activa/i);
    assert.match(lastReply, /dejar tu perfil registrado/i);
  } finally {
    restoreAxios();
  }
});
