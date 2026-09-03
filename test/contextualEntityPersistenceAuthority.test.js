// Replay sintético de autoridad semántica y persistencia; no contiene PII real.
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { ConversationStep, ReminderState } from '@prisma/client';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';
import { runChatEngine } from '../src/services/chatEngine.js';
import { getCandidateReadiness } from '../src/services/readinessGuard.js';
import { conversationUnderstanding } from '../src/services/conversationUnderstanding.js';
import { parseNaturalData } from '../src/services/candidateData.js';

const vacancy = Object.freeze({
  id: 'vac-test-1566',
  title: 'Auxiliar de Bodega',
  role: 'Auxiliar de bodega',
  city: 'Bogotá',
  operation: { city: { name: 'Bogotá' } },
  isActive: true,
  acceptingApplications: true,
  schedulingEnabled: false,
  experienceRequired: 'NO'
});

function candidate(overrides = {}) {
  return {
    id: 'candidate-test-1566',
    vacancyId: vacancy.id,
    currentStep: ConversationStep.COLLECTING_DATA,
    status: 'REGISTRADO',
    fullName: 'Persona Ejemplo',
    documentType: 'CC',
    documentNumber: 'TEST-DOC-1566',
    age: 22,
    locality: 'Usme',
    neighborhood: null,
    medicalRestrictions: null,
    transportMode: null,
    gender: 'UNKNOWN',
    cvStorageKey: null,
    cvData: null,
    cvOriginalName: null,
    cvMimeType: null,
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE,
    botPaused: false,
    ...overrides
  };
}

function statefulPrisma(initialCandidate) {
  let state = { ...initialCandidate };
  const updates = [];
  return {
    updates,
    getState: () => ({ ...state }),
    candidate: {
      update: async ({ data }) => {
        updates.push({ ...data });
        state = { ...state, ...data };
        return { ...state };
      },
      updateMany: async ({ where = {}, data = {} }) => {
        if (where.currentStep !== undefined && where.currentStep !== state.currentStep) return { count: 0 };
        state = { ...state, ...data };
        return { count: 1 };
      },
      findUnique: async () => ({ ...state })
    },
    interviewBooking: {
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 })
    },
    botKnowledge: { findMany: async () => [] }
  };
}

async function withEngineDecision(decision, callback) {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalPost = axios.post;
  process.env.OPENAI_API_KEY = 'test-key';
  axios.post = async (url) => {
    assert.match(String(url), /chat\/completions/);
    return {
      data: {
        choices: [{ message: { content: JSON.stringify(decision) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      }
    };
  };
  try {
    return await callback();
  } finally {
    axios.post = originalPost;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
}

const multipurposeContext = Object.freeze({
  currentStep: ConversationStep.COLLECTING_DATA,
  pendingFields: ['restricciones medicas', 'medio de transporte'],
  lastBotQuestion: '¿Tienes alguna restricción médica para realizar labores de bodega? También cuéntame cuál es tu medio de transporte habitual.'
});

test('una negativa corta contextual se acepta como ausencia de restricciones médicas', () => {
  const result = sanitizeCandidateFieldsForConversation({
    fields: { medicalRestrictions: 'No' },
    evidence: {
      medicalRestrictions: { snippet: 'Noo', confidence: 0.94, source: 'engine' }
    },
    text: 'Noo\nTransporte público',
    context: multipurposeContext,
    turnType: 'PROVIDE_DATA'
  });

  assert.equal(result.fields.medicalRestrictions, 'Sin restricciones médicas');
});

test('una negativa corta fuera de contexto médico no se convierte en dato de salud', () => {
  const result = sanitizeCandidateFieldsForConversation({
    fields: { medicalRestrictions: 'No' },
    evidence: {
      medicalRestrictions: { snippet: 'No', confidence: 0.94, source: 'engine' }
    },
    text: 'No',
    context: {
      currentStep: ConversationStep.COLLECTING_DATA,
      pendingFields: ['medio de transporte'],
      lastBotQuestion: '¿Cuál es tu medio de transporte habitual?'
    },
    turnType: 'CONFIRMATION'
  });

  assert.equal(result.fields.medicalRestrictions, undefined);
});

test('el engine persiste restricciones y transporte entendidos en una respuesta contextual de varios fragmentos', async () => {
  const initial = candidate();
  const prisma = statefulPrisma(initial);
  const recentMessages = [
    {
      direction: 'OUTBOUND',
      body: multipurposeContext.lastBotQuestion,
      rawPayload: { source: 'bot_flow' }
    }
  ];

  const decision = {
    reply: 'Listo, entendí ambos datos y continúo con lo que realmente falta.',
    nextStep: ConversationStep.COLLECTING_DATA,
    actions: [{
      type: 'save_fields',
      data: { medicalRestrictions: 'No', transportMode: 'Transporte público' }
    }],
    extractedFields: { medicalRestrictions: 'No', transportMode: 'Transporte público' },
    detectedIntent: 'provide_data',
    uncertainty: 0.05,
    needsHumanReview: false
  };

  await withEngineDecision(decision, async () => {
    await runChatEngine({
      prisma,
      candidate: initial,
      vacancy,
      inboundText: 'Noo\nTransporte público',
      recentMessages,
      candidateFieldHints: {}
    });
  });

  const persisted = prisma.getState();
  assert.equal(persisted.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(persisted.transportMode, 'Publico');

  const readiness = getCandidateReadiness(persisted, vacancy, { requireCv: false });
  assert.doesNotMatch(readiness.missingFields.join(','), /medicalRestrictions|transportMode/);
});

test('los campos ya curados por conversationUnderstanding tienen precedencia sobre una segunda extracción del engine', async () => {
  const initial = candidate({ locality: null, medicalRestrictions: 'Sin restricciones médicas', transportMode: 'Publico' });
  const prisma = statefulPrisma(initial);
  const recentMessages = [{
    direction: 'OUTBOUND',
    body: '¿En qué localidad de Bogotá vives?',
    rawPayload: { source: 'bot_flow' }
  }];
  const decision = {
    reply: 'Gracias, continúo con tu registro.',
    nextStep: ConversationStep.COLLECTING_DATA,
    actions: [{ type: 'save_fields', data: { locality: 'Suba' } }],
    extractedFields: { locality: 'Suba' },
    detectedIntent: 'provide_data',
    uncertainty: 0.2,
    needsHumanReview: false
  };

  await withEngineDecision(decision, async () => {
    await runChatEngine({
      prisma,
      candidate: initial,
      vacancy,
      inboundText: 'Vivo en Usme',
      recentMessages,
      candidateFieldHints: { locality: 'Usme' }
    });
  });

  assert.equal(prisma.getState().locality, 'Usme');
});

test('localidad y transporte de una frase natural quedan en sus entidades correctas', async () => {
  const text = 'Vivo en la localidad de Usme y me movilizo en transporte público';
  const result = await conversationUnderstanding(text, {
    context: {
      currentStep: ConversationStep.COLLECTING_DATA,
      pendingFields: ['localidad', 'medio de transporte'],
      lastBotQuestion: 'Cuéntame tu localidad y tu medio de transporte.'
    },
    aiResult: {
      status: 'disabled',
      intent: null,
      parsedFields: {},
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    },
    runtime: {
      localParsedData: parseNaturalData(text),
      engineFields: {},
      engineUsage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      fallbackIntent: 'continue_application',
      vacancy,
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.turnInterpretation.fields.locality, 'Usme');
  assert.equal(result.turnInterpretation.fields.transportMode, 'Publico');
  assert.notEqual(result.turnInterpretation.fields.fullName, 'Usme');
  assert.notEqual(result.turnInterpretation.fields.neighborhood, 'Usme');
});

test('después de persistir entidades y recibir una hoja de vida válida no reaparecen como pendientes', () => {
  const persisted = candidate({
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Publico',
    cvStorageKey: 'cv/test-1566.pdf',
    cvOriginalName: 'hoja-de-vida-test.pdf',
    cvMimeType: 'application/pdf'
  });

  const readiness = getCandidateReadiness(persisted, vacancy);
  assert.deepEqual(readiness.missingFields, []);
  assert.equal(readiness.hasValidCv, true);
  assert.equal(readiness.readyForDone, true);
});
