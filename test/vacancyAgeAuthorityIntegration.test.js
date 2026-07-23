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

const referenceCase = conversationCases.find((item) => item.id === 'age-not-experience');

function buildCandidate(id, overrides = {}) {
  assert.ok(referenceCase, 'debe existir el escenario base de edad');
  return {
    ...referenceCase.candidate,
    id,
    phone: `57300${id.replace(/\D/g, '').padStart(7, '0').slice(-7)}`,
    currentStep: 'COLLECTING_DATA',
    vacancyId: 'vac-post',
    ...overrides
  };
}

async function runAgeTurn({
  id,
  text,
  vacancyOverrides = {},
  candidateOverrides = {}
}) {
  const candidate = buildCandidate(id, candidateOverrides);
  const vacancy = {
    ...baseVacancies[0],
    minAge: 18,
    maxAge: null,
    ...vacancyOverrides
  };
  const prisma = createMockPrisma({
    candidates: [candidate],
    messages: [],
    vacancies: [vacancy, ...baseVacancies.slice(1)],
    operations: baseOperations,
    interviewSlots: [],
    interviewBookings: []
  });
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    const createdAt = new Date('2026-07-23T20:00:00.000Z');
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
      candidate: prisma.state.candidates.find((item) => item.id === candidate.id),
      outbound: whatsappMock.sentMessages
    };
  } finally {
    restoreAxios();
  }
}

test('una vacante sin edad máxima permite una edad mayor de 50', async () => {
  const result = await runAgeTurn({
    id: 'age-1',
    text: 'Tengo 56 años',
    vacancyOverrides: { minAge: 18, maxAge: null }
  });

  assert.equal(result.candidate.age, 56);
  assert.notEqual(result.candidate.status, 'RECHAZADO');
});

test('un rango personalizado permite edades válidas por encima del antiguo máximo global', async () => {
  const result = await runAgeTurn({
    id: 'age-2',
    text: 'Tengo 56 años',
    vacancyOverrides: { minAge: 21, maxAge: 60 }
  });

  assert.equal(result.candidate.age, 56);
  assert.notEqual(result.candidate.status, 'RECHAZADO');
});

test('una edad superior al máximo configurado usa el código y rango canónicos', async () => {
  const result = await runAgeTurn({
    id: 'age-3',
    text: 'Tengo 56 años',
    vacancyOverrides: { minAge: 18, maxAge: 55 }
  });

  assert.equal(result.candidate.status, 'RECHAZADO');
  assert.match(result.candidate.rejectionReason, /entre 18 y 55 años/i);
  assert.match(result.candidate.rejectionDetails, /Edad detectada: 56/i);
  assert.match(result.candidate.rejectionDetails, /Rango requerido: entre 18 y 55 años/i);
  assert.match(result.candidate.rejectionDetails, /Código: age_above_max/i);
});

test('una edad inferior al mínimo personalizado usa la misma autoridad', async () => {
  const result = await runAgeTurn({
    id: 'age-4',
    text: 'Tengo 20 años',
    vacancyOverrides: { minAge: 21, maxAge: 60 }
  });

  assert.equal(result.candidate.status, 'RECHAZADO');
  assert.match(result.candidate.rejectionDetails, /Código: age_below_min/i);
  assert.match(result.candidate.rejectionDetails, /Rango requerido: entre 21 y 60 años/i);
});

test('direcciones y cantidades laborales no se convierten en edad de rechazo', async () => {
  const result = await runAgeTurn({
    id: 'age-5',
    text: 'Vivo en la calle 56 y manejé grupos mayores a 60 trabajadores por turno',
    vacancyOverrides: { minAge: 18, maxAge: 55 },
    candidateOverrides: { age: 42 }
  });

  assert.equal(result.candidate.age, 42);
  assert.notEqual(result.candidate.status, 'RECHAZADO');
});
