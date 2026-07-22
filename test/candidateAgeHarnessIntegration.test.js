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
  (conversationCase) => conversationCase.id === 'experience-headcount-number-does-not-trigger-age-rejection'
);

test('métricas laborales no sobrescriben la edad existente en el flujo integral', async () => {
  assert.ok(targetCase, 'el escenario objetivo debe existir en el corpus');
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
    const body = targetCase.steps[0];
    const createdAt = new Date('2026-07-22T19:00:00.000Z');
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
    assert.equal(finalCandidate.age, 42);
    assert.notEqual(finalCandidate.status, 'RECHAZADO');
    assert.ok(
      !whatsappMock.sentMessages.some((message) => /edad fuera del rango|no es posible continuar con tu postulacion/i.test(message.body)),
      'la respuesta no debe rechazar por una métrica laboral'
    );
  } finally {
    restoreAxios();
  }
});
