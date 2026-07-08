import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { ConversationStep, Gender } from '@prisma/client';
import { act, buildCandidateStateForModel, think } from '../src/services/conversationEngine.js';

function completeCandidate(overrides = {}) {
  return {
    id: 1,
    vacancyId: 10,
    currentStep: ConversationStep.ASK_CV,
    fullName: 'Fredy Granados',
    documentType: 'CC',
    documentNumber: '1000788203',
    age: 23,
    medicalRestrictions: 'Sin restricciones medicas',
    transportMode: 'Bus',
    locality: 'Ciudad Bolívar',
    gender: Gender.MALE,
    cvStorageKey: 'cv/1.pdf',
    cvOriginalName: 'cv.pdf',
    cvMimeType: 'application/pdf',
    ...overrides
  };
}

function schedulableVacancy(overrides = {}) {
  return { id: 10, schedulingEnabled: true, isActive: true, acceptingApplications: true, city: 'Bogotá', ...overrides };
}

function nextSlot() {
  return { slot: { id: 99 }, date: new Date('2026-06-01T14:00:00.000Z'), windowOk: true };
}

function prismaMock() {
  const updates = [];
  return {
    updates,
    candidate: {
      update: async (args) => { updates.push(args); return { id: args.where.id, ...args.data }; }
    }
  };
}

async function thinkWithModelReply({ reply, raw = {}, recentMessages = [], inboundText = 'ok', candidate = completeCandidate(), currentStep = ConversationStep.COLLECTING_DATA }) {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalPost = axios.post;
  process.env.OPENAI_API_KEY = 'test-key';
  axios.post = async () => ({
    data: {
      choices: [{
        message: {
          content: JSON.stringify({
            reply,
            nextStep: currentStep,
            actions: [{ type: 'nothing' }],
            extractedFields: {},
            ...raw
          })
        }
      }]
    }
  });

  try {
    return await think({
      inboundText,
      candidate,
      vacancy: schedulableVacancy(),
      recentMessages,
      currentStep
    });
  } finally {
    axios.post = originalPost;
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  }
}

test('bloquea offer_interview para candidata FEMALE', async () => {
  const prisma = prismaMock();
  await act({ prisma, candidate: completeCandidate({ gender: Gender.FEMALE }), vacancy: schedulableVacancy(), nextSlot: nextSlot(), actions: [{ type: 'offer_interview' }], nextStep: ConversationStep.SCHEDULING });
  assert.equal(prisma.updates.some((u) => u.data.currentStep === ConversationStep.SCHEDULING), false);
  assert.equal(prisma.updates.at(-1).data.botPaused, true);
});

test('bloquea confirm_booking sin CV', async () => {
  const prisma = prismaMock();
  let bookingCreated = false;
  prisma.interviewBooking = { create: async () => { bookingCreated = true; } };
  await act({ prisma, candidate: completeCandidate({ cvStorageKey: null }), vacancy: schedulableVacancy(), nextSlot: nextSlot(), actions: [{ type: 'confirm_booking' }] });
  assert.equal(bookingCreated, false);
  assert.equal(prisma.updates.some((u) => u.data.currentStep === ConversationStep.SCHEDULED), false);
});

test('bloquea agenda con vacancy.schedulingEnabled=false', async () => {
  const prisma = prismaMock();
  await act({ prisma, candidate: completeCandidate(), vacancy: schedulableVacancy({ schedulingEnabled: false }), nextSlot: nextSlot(), actions: [{ type: 'offer_interview' }] });
  assert.equal(prisma.updates.some((u) => u.data.currentStep === ConversationStep.SCHEDULING), false);
});

test('bloquea agenda sin nextSlot', async () => {
  const prisma = prismaMock();
  await act({ prisma, candidate: completeCandidate(), vacancy: schedulableVacancy(), nextSlot: null, actions: [{ type: 'offer_interview' }] });
  assert.equal(prisma.updates.at(-1).data.botPaused, true);
});

test('bloquea agenda con vacante inactiva', async () => {
  const prisma = prismaMock();
  await act({ prisma, candidate: completeCandidate(), vacancy: schedulableVacancy({ isActive: false }), nextSlot: nextSlot(), actions: [{ type: 'offer_interview' }] });
  assert.equal(prisma.updates.some((u) => u.data.currentStep === ConversationStep.SCHEDULING), false);
});

test('estado del motor mantiene localidad pendiente si la residencia reportada es Soacha', () => {
  const state = buildCandidateStateForModel(
    completeCandidate({ locality: 'Soacha Cundinamarca', neighborhood: null, cvStorageKey: null }),
    schedulableVacancy({ schedulingEnabled: false }),
    []
  );

  assert.equal(state.profile.residenceArea.field, 'locality');
  assert.equal(state.profile.residenceArea.state.captured, false);
  assert.equal(state.profile.locality.captured, false);
  assert.equal(state.profile.locality.value, null);
  assert.equal(state.progress.missingFields.includes('locality'), true);
});

test('act no alinea Soacha como localidad para Bogota', async () => {
  const prisma = prismaMock();
  const candidate = completeCandidate({ locality: null, neighborhood: null, cvStorageKey: null });

  const result = await act({
  prisma,
  candidate,
  vacancy: schedulableVacancy({ schedulingEnabled: false }),
  actions: [{ type: 'save_fields', data: { neighborhood: 'Soacha Compartir' } }, { type: 'request_cv' }],
  extractedFields: { neighborhood: 'Soacha Compartir' }
});

assert.equal(prisma.updates.some((update) => update.data.locality === 'Soacha Cundinamarca'), false);
assert.equal(prisma.updates.some((update) => update.data.neighborhood === 'Soacha Compartir'), false);
assert.equal(result.finalStep, ConversationStep.COLLECTING_DATA);
});

test('loop guard permite repetir respuesta logística cuando responde una pregunta real', async () => {
  const reply = 'La entrevista es mañana a las 8:00 a. m. en la sede indicada; lleva tu documento y hoja de vida.';
  const decision = await thinkWithModelReply({
    inboundText: '¿A qué hora y dónde es la entrevista?',
    reply,
    raw: { detectedIntent: 'logistics_question', responsePurpose: 'answer_logistics_question' },
    recentMessages: [
      { direction: 'OUTBOUND', body: reply, rawPayload: { source: 'conversation_engine' } },
      { direction: 'INBOUND', body: '¿A qué hora y dónde es la entrevista?' }
    ],
    currentStep: ConversationStep.SCHEDULING
  });

  assert.equal(decision.reply, reply);
  assert.equal(decision.loopGuardApplied, false);
});

test('loop guard activa fallback ante tres pedidos del mismo dato faltante sin progreso', async () => {
  const reply = 'Para avanzar necesito que me compartas tu número de documento.';
  const decision = await thinkWithModelReply({
    reply,
    recentMessages: [
      { direction: 'OUTBOUND', body: reply, rawPayload: { source: 'conversation_engine' } },
      { direction: 'OUTBOUND', body: 'Compárteme tu número de documento para continuar.', rawPayload: { source: 'conversation_engine' } },
      { direction: 'OUTBOUND', body: 'Necesito tu número de documento para seguir.', rawPayload: { source: 'conversation_engine' } }
    ],
    candidate: completeCandidate({ documentNumber: null }),
    currentStep: ConversationStep.COLLECTING_DATA
  });

  assert.equal(decision.loopGuardApplied, true);
  assert.notEqual(decision.reply, reply);
});

test('loop guard no se activa en replies menores a 5 tokens salvo igualdad exacta', async () => {
  const similarShort = await thinkWithModelReply({
    reply: 'Sí correcto',
    recentMessages: [{ direction: 'OUTBOUND', body: 'Correcto sí', rawPayload: { source: 'conversation_engine' } }]
  });
  assert.equal(similarShort.loopGuardApplied, false);

  const exactShort = await thinkWithModelReply({
    reply: 'Correcto',
    recentMessages: [{ direction: 'OUTBOUND', body: 'Correcto', rawPayload: { source: 'conversation_engine' } }]
  });
  assert.equal(exactShort.loopGuardApplied, true);
});

test('loop guard detecta parafraseo de solicitud de HV por intención y acción', async () => {
  const decision = await thinkWithModelReply({
    reply: 'Compárteme tu hoja de vida en formato PDF o Word para continuar con tu postulación.',
    raw: { responsePurpose: 'request_cv', actions: [{ type: 'request_cv' }] },
    recentMessages: [
      { direction: 'OUTBOUND', body: 'Envíame tu HV en PDF o DOCX para seguir con el proceso.', rawPayload: { source: 'conversation_engine', responsePurpose: 'request_cv', actions: [{ type: 'request_cv' }] } },
      { direction: 'OUTBOUND', body: 'Necesito adjuntar tu currículum en archivo PDF o Word antes de continuar.', rawPayload: { source: 'conversation_engine', responsePurpose: 'request_cv', actions: [{ type: 'request_cv' }] } }
    ],
    currentStep: ConversationStep.ASK_CV
  });

  assert.equal(decision.loopGuardApplied, true);
});

test('loopGuardApplied permanece false cuando hay extractedFields nuevos', async () => {
  const reply = 'Gracias, registré tu número de documento y seguimos con el proceso.';
  const decision = await thinkWithModelReply({
    reply,
    raw: { extractedFields: { documentNumber: '1000788203' } },
    recentMessages: [{ direction: 'OUTBOUND', body: reply, rawPayload: { source: 'conversation_engine' } }]
  });

  assert.equal(decision.loopGuardApplied, false);
});
