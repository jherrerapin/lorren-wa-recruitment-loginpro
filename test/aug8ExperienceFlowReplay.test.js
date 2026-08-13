import test from 'node:test';
import assert from 'node:assert/strict';
import { baseOperations, baseVacancies, conversationCases } from './fixtures/conversationCases.js';
import { runConversationCase } from './helpers/conversationHarness.js';

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.USE_CONVERSATION_ENGINE = 'true';
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';

const { processText } = await import('../src/routes/webhook.js');
const { createDebugTrace } = await import('../src/services/debugTrace.js');

const baseExperienceCase = conversationCases.find(
  (conversationCase) => conversationCase.id === 'experience-headcount-number-does-not-trigger-age-rejection'
);

const experienceVacancies = baseVacancies.map((vacancy) => (
  vacancy.id === 'vac-post'
    ? {
        ...vacancy,
        experienceRequired: 'YES',
        experienceTimeText: 'mínimo 6 meses'
      }
    : vacancy
));

function buildAug8ReplayCase() {
  assert.ok(baseExperienceCase, 'el corpus base de experiencia debe existir');
  return {
    id: 'aug8-experience-summary-full-flow',
    candidate: {
      ...baseExperienceCase.candidate,
      id: 'candidate-aug8-experience-summary',
      phone: 'TEST-PHONE-901',
      fullName: 'Persona Ejemplo',
      documentType: 'CC',
      documentNumber: 'TEST-DOC-901',
      age: 34,
      neighborhood: 'Barrio Ejemplo',
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Moto',
      experienceInfo: 'Sí',
      experienceTime: '6 meses',
      experienceSummary: null,
      currentStep: 'COLLECTING_DATA',
      vacancyId: 'vac-post'
    },
    preMessages: [
      {
        direction: 'OUTBOUND',
        body: 'Listo, ya actualicé tus datos. Para seguir me falta: en qué tienes experiencia.',
        rawPayload: { source: 'bot_flow', actor: 'BOT' },
        createdAt: new Date('2026-08-08T21:00:00.000Z')
      }
    ],
    steps: ['En consumo masivo con supervisor logístico'],
    vacancies: experienceVacancies,
    operations: baseOperations
  };
}

async function runAug8Replay() {
  return runConversationCase(buildAug8ReplayCase(), {
    processText,
    createDebugTrace,
    recognizeCurrentEnginePrompt: true,
    assertExpectations: false
  });
}

function normalize(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

test('replay Aug-8 persistencia: guarda la experiencia laboral libre', async () => {
  const result = await runAug8Replay();
  assert.equal(result.candidate.experienceInfo, 'Sí');
  assert.equal(result.candidate.experienceTime, '6 meses');
  assert.match(result.candidate.experienceSummary || '', /consumo masivo/i);
  assert.match(result.candidate.experienceSummary || '', /supervisor log[ií]stico/i);
  assert.ok(
    result.debugTraces.some((trace) => trace.persisted_fields.includes('experienceSummary')),
    'el turno debe persistir experienceSummary'
  );
});

test('replay Aug-8 avance: deja de tener experiencia pendiente y pasa a ASK_CV', async () => {
  const result = await runAug8Replay();
  assert.equal(result.candidate.currentStep, 'ASK_CV');
});

test('replay Aug-8 respuesta: pide CV una vez sin repetir vacante ni experiencia', async () => {
  const result = await runAug8Replay();
  const replies = result.outbound.filter((message) => String(message?.to || '') === result.candidate.phone);
  assert.equal(replies.length, 1);

  const reply = normalize(replies.at(-1)?.body);
  assert.match(reply, /hoja de vida/);
  assert.doesNotMatch(reply, /la vacante que tengo para ti/);
  assert.doesNotMatch(reply, /aun me faltan/);
  assert.doesNotMatch(reply, /en que tiene experiencia/);
});
