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

const TARGETS = [
  {
    id: 'ibague-flow-name-correction-and-transport-list',
    expectedAge: 24,
    expectedStep: 'ASK_CV'
  },
  {
    id: 'ibague-role-phrase-does-not-become-name-and-name-correction-sticks',
    expectedAge: 30,
    expectedStep: 'ASK_CV'
  },
  {
    id: 'future-birthday-keeps-current-age-and-does-not-repeat-transport',
    expectedAge: 18,
    expectedStep: 'SCHEDULING'
  }
];

async function runConversationCase(conversationCase) {
  const candidate = { ...conversationCase.candidate };
  const prisma = createMockPrisma({
    candidates: [candidate],
    messages: (conversationCase.preMessages || []).map((message, index) => ({
      id: `pre-${index + 1}`,
      candidateId: candidate.id,
      messageType: 'TEXT',
      respondedAt: null,
      ...message
    })),
    vacancies: conversationCase.vacancies || baseVacancies,
    operations: conversationCase.operations || baseOperations,
    interviewSlots: conversationCase.interviewSlots || [],
    interviewBookings: conversationCase.interviewBookings || []
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    for (const [index, body] of conversationCase.steps.entries()) {
      const createdAt = new Date(Date.UTC(2026, 6, 22, 23, 50 + index));
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
    }

    return {
      candidate: prisma.state.candidates[0],
      outbound: whatsappMock.sentMessages
    };
  } finally {
    restoreAxios();
  }
}

for (const target of TARGETS) {
  test(`${target.id} conserva la edad estructurada correcta`, async () => {
    const conversationCase = conversationCases.find((item) => item.id === target.id);
    assert.ok(conversationCase, `debe existir ${target.id}`);

    const result = await runConversationCase(conversationCase);
    assert.equal(result.candidate.age, target.expectedAge);
    assert.equal(result.candidate.currentStep, target.expectedStep);
    assert.notEqual(result.candidate.status, 'RECHAZADO');
    assert.ok(
      !result.outbound.some((message) => /edad fuera del rango|no es posible continuar con tu postulacion/i.test(message.body)),
      'el flujo no debe rechazar por una cifra ajena a la edad actual'
    );
  });
}
