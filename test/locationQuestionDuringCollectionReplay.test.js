import test from 'node:test';
import assert from 'node:assert/strict';
import { baseOperations, baseVacancies } from './fixtures/conversationCases.js';
import { runConversationCase } from './helpers/conversationHarness.js';

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.USE_CONVERSATION_ENGINE = 'true';
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';

const { processText } = await import('../src/routes/webhook.js');
const { createDebugTrace } = await import('../src/services/debugTrace.js');

function buildLocationQuestionCase() {
  return {
    id: 'location-question-during-data-collection',
    candidate: {
      id: 'candidate-location-question-replay',
      phone: 'TEST-PHONE-LOCATION-QUESTION',
      status: 'EN_PROCESO',
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-post',
      dataConsentStatus: 'ACCEPTED',
      fullName: null,
      documentType: null,
      documentNumber: null,
      age: null,
      gender: 'UNKNOWN',
      neighborhood: 'Barrio Ejemplo',
      locality: null,
      medicalRestrictions: null,
      transportMode: null,
      experienceInfo: null,
      experienceTime: null,
      experienceSummary: null,
      cvData: null,
      cvOriginalName: null,
      cvMimeType: null,
      reminderState: 'NONE',
      reminderScheduledFor: null,
      botPaused: false,
      botPausedAt: null,
      botPauseReason: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      createdAt: new Date('2026-08-08T15:00:00.000Z')
    },
    preMessages: [
      {
        direction: 'OUTBOUND',
        body: 'Para seguir con tu postulación, cuéntame los datos que te falten en el orden que prefieras.',
        rawPayload: { source: 'bot_flow', actor: 'BOT' },
        createdAt: new Date('2026-08-08T15:05:00.000Z')
      }
    ],
    steps: ['En donde estan ubicados'],
    vacancies: baseVacancies,
    operations: baseOperations
  };
}

function normalize(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

test('replay ubicación: responde la pregunta antes de retomar la recolección', async () => {
  const result = await runConversationCase(buildLocationQuestionCase(), {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true,
    assertExpectations: false
  });

  const replies = result.outbound.filter((message) => String(message?.to || '') === result.candidate.phone);
  assert.equal(replies.length, 1);

  const reply = normalize(replies.at(-1)?.body);
  assert.match(reply, /zona industrial de ibague/);
  assert.doesNotMatch(reply, /gracias, ese dato quedo registrado/);
  assert.doesNotMatch(reply, /la vacante que tengo para ti/);
  assert.doesNotMatch(reply, /nombre completo, tipo de documento, numero de documento, edad/);
});

test('replay ubicación: una pregunta no modifica perfil ni reinicia el estado', async () => {
  const result = await runConversationCase(buildLocationQuestionCase(), {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true,
    assertExpectations: false
  });

  assert.equal(result.candidate.currentStep, 'COLLECTING_DATA');
  assert.equal(result.candidate.neighborhood, 'Barrio Ejemplo');

  const persisted = new Set(result.debugTraces.flatMap((trace) => trace.persisted_fields || []));
  for (const field of ['fullName', 'documentType', 'documentNumber', 'age', 'neighborhood', 'medicalRestrictions', 'transportMode']) {
    assert.equal(persisted.has(field), false, `la pregunta no debe persistir ${field}`);
  }
});
