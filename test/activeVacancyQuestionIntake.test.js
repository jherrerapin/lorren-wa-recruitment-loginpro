import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { installOpenAIMock } from './helpers/mockOpenAI.js';
import { baseOperations, baseVacancies, conversationCases } from './fixtures/conversationCases.js';

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.USE_CONVERSATION_ENGINE = 'true';
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';

const { processText } = await import('../src/routes/webhook.js');
const { createDebugTrace } = await import('../src/services/debugTrace.js');

const targetCase = conversationCases.find(
  (conversationCase) => conversationCase.id === 'answer-question-before-data'
);

async function runTurn(text) {
  assert.ok(targetCase, 'el escenario objetivo debe existir');
  const candidate = { ...targetCase.candidate };
  const prisma = createMockPrisma({
    candidates: [candidate],
    messages: [],
    vacancies: targetCase.vacancies || baseVacancies,
    operations: targetCase.operations || baseOperations,
    interviewSlots: targetCase.interviewSlots || [],
    interviewBookings: targetCase.interviewBookings || []
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    const createdAt = new Date('2026-07-22T23:20:00.000Z');
    await prisma.message.create({
      data: {
        candidateId: candidate.id,
        direction: 'INBOUND',
        messageType: 'TEXT',
        body: text,
        rawPayload: { body: text, source: 'candidate' },
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
    await processText(prisma, freshCandidate, candidate.phone, text, debugTrace, {});

    return {
      candidate: prisma.state.candidates[0],
      reply: whatsappMock.sentMessages.at(-1)?.body || '',
      outbound: whatsappMock.sentMessages
    };
  } finally {
    restoreAxios();
  }
}

test('interés explícito y pregunta responde primero y entra a recolección', async () => {
  const result = await runTurn(targetCase.steps[0]);

  assert.equal(result.candidate.vacancyId, 'vac-sched');
  assert.equal(result.candidate.currentStep, 'COLLECTING_DATA');
  assert.match(result.reply, /condiciones registradas/i);
  assert.match(result.reply, /comp[aá]rteme/i);
  assert.doesNotMatch(result.reply, /Perfecto, por favor confirma/i);
  assert.equal(result.outbound.length, 1);
});

test('consulta informativa sin interés conserva GREETING_SENT', async () => {
  const result = await runTurn('vacante de mensajero en bogota, que horario tienen?');

  assert.equal(result.candidate.vacancyId, 'vac-sched');
  assert.equal(result.candidate.currentStep, 'GREETING_SENT');
  assert.match(result.reply, /condiciones registradas/i);
  assert.doesNotMatch(result.reply, /comp[aá]rteme/i);
});

test('interés sin pregunta conserva el comportamiento actual', async () => {
  const result = await runTurn('me interesa la vacante de mensajero en bogota');

  assert.equal(result.candidate.vacancyId, 'vac-sched');
  assert.equal(result.candidate.currentStep, 'GREETING_SENT');
  assert.doesNotMatch(result.reply, /comp[aá]rteme/i);
});

test('solo ciudad no asigna vacante ni inicia recolección', async () => {
  const result = await runTurn('Estoy en Bogota');

  assert.equal(result.candidate.vacancyId, null);
  assert.equal(result.candidate.currentStep, 'GREETING_SENT');
  assert.doesNotMatch(result.reply, /comp[aá]rteme/i);
});
