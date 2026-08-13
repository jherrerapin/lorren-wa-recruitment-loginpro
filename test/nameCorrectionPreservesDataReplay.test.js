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

function buildCorrectionCase() {
  return {
    id: 'name-correction-preserves-complete-profile',
    candidate: {
      id: 'candidate-name-correction-replay',
      phone: 'TEST-PHONE-NAME-CORRECTION',
      status: 'EN_PROCESO',
      currentStep: 'ASK_CV',
      vacancyId: 'vac-post',
      dataConsentStatus: 'ACCEPTED',
      fullName: 'Nombre Anterior',
      documentType: 'CC',
      documentNumber: 'TESTDOC90101',
      age: 29,
      gender: 'UNKNOWN',
      neighborhood: 'Barrio Ejemplo',
      locality: null,
      medicalRestrictions: 'Sin restricciones médicas',
      transportMode: 'Bicicleta',
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
        body: 'Listo, ya tengo tus datos. Cuando puedas, adjunta tu hoja de vida en PDF o Word/DOCX.',
        rawPayload: { source: 'bot_flow', actor: 'BOT' },
        createdAt: new Date('2026-08-08T15:05:00.000Z')
      }
    ],
    steps: ['Corrijo mi nombre: Camila Torres'],
    vacancies: baseVacancies,
    operations: baseOperations
  };
}

async function runCorrectionReplay() {
  return runConversationCase(buildCorrectionCase(), {
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

test('replay corrección: actualiza únicamente el nombre y conserva los datos ya persistidos', async () => {
  const result = await runCorrectionReplay();
  const candidate = result.candidate;

  assert.equal(candidate.fullName, 'Camila Torres');
  assert.equal(candidate.documentType, 'CC');
  assert.equal(candidate.documentNumber, 'TESTDOC90101');
  assert.equal(candidate.age, 29);
  assert.equal(candidate.neighborhood, 'Barrio Ejemplo');
  assert.equal(candidate.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(candidate.transportMode, 'Bicicleta');
  assert.equal(candidate.dataConsentStatus, 'ACCEPTED');
});

test('replay corrección: no retrocede desde ASK_CV ni vuelve a solicitar datos completos', async () => {
  const result = await runCorrectionReplay();
  assert.equal(result.candidate.currentStep, 'ASK_CV');

  const replies = result.outbound.filter((message) => String(message?.to || '') === result.candidate.phone);
  assert.equal(replies.length, 1);

  const reply = normalize(replies.at(-1)?.body);
  assert.match(reply, /hoja de vida/);
  assert.doesNotMatch(reply, /nombre completo/);
  assert.doesNotMatch(reply, /tipo de documento/);
  assert.doesNotMatch(reply, /numero de documento/);
  assert.doesNotMatch(reply, /edad/);
  assert.doesNotMatch(reply, /barrio/);
  assert.doesNotMatch(reply, /restricciones/);
  assert.doesNotMatch(reply, /medio de transporte/);
  assert.doesNotMatch(reply, /la vacante que tengo para ti/);
});

test('replay corrección: la traza persiste el nombre corregido sin reescribir campos ajenos', async () => {
  const result = await runCorrectionReplay();
  const persisted = new Set(result.debugTraces.flatMap((trace) => trace.persisted_fields || []));

  assert.equal(persisted.has('fullName'), true);
  for (const field of ['documentType', 'documentNumber', 'age', 'neighborhood', 'medicalRestrictions', 'transportMode']) {
    assert.equal(persisted.has(field), false, `no debe reescribir ${field}`);
  }
});
