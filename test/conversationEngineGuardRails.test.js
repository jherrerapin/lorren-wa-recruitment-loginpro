import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { ConversationStep, Gender, ReminderState } from '@prisma/client';
import { alignCandidateLocationFields } from '../src/services/candidateData.js';
import { act, buildCandidateStateForModel, parseEngineJson, think } from '../src/services/conversationEngine.js';

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
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE,
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
  const stepUpdates = [];
  const bookings = [];
  let persistedStep = null;
  return {
    updates,
    stepUpdates,
    bookings,
    candidate: {
      update: async (args) => { updates.push(args); return { id: args.where.id, ...args.data }; },
      updateMany: async (args) => {
        stepUpdates.push(args);
        persistedStep = args.data.currentStep;
        return { count: 1 };
      },
      findUnique: async (args) => ({ id: args.where.id, currentStep: persistedStep })
    },
    interviewBooking: {
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
      create: async (args) => { bookings.push(args); return { id: bookings.length, ...args.data }; }
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


test('parseEngineJson acepta JSON valido estricto y expone estrategia strict', () => {
  const parsed = parseEngineJson('{"reply":"Hola","nextStep":"COLLECTING_DATA","actions":[],"extractedFields":{}}');

  assert.equal(parsed.reply, 'Hola');
  assert.equal(parsed.__parseStrategy, 'strict');
});

test('parseEngineJson acepta JSON dentro de markdown y expone estrategia markdown', () => {
  const parsed = parseEngineJson('```json\n{"reply":"Hola desde markdown","actions":[],"extractedFields":{}}\n```');

  assert.equal(parsed.reply, 'Hola desde markdown');
  assert.equal(parsed.__parseStrategy, 'markdown');
});

test('parseEngineJson acepta objeto JSON balanceado rodeado de texto', () => {
  const parsed = parseEngineJson('Claro, devuelvo esto: {"reply":"Hola rodeado","actions":[],"extractedFields":{}} gracias.');

  assert.equal(parsed.reply, 'Hola rodeado');
  assert.equal(parsed.__parseStrategy, 'balanced');
});

test('parseEngineJson repara keys sin comillas y strings simples solo con schema minimo valido', () => {
  const parsed = parseEngineJson("{reply: 'Hola reparado', actions: [], extractedFields: {}}");

  assert.equal(parsed.reply, 'Hola reparado');
  assert.equal(parsed.__parseStrategy, 'repaired');
});

test('parseEngineJson no corrompe reply con comillas y dos puntos invalidos; usa fallback seguro', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalPost = axios.post;
  const originalWarn = console.warn;
  const warnings = [];
  process.env.OPENAI_API_KEY = 'test-key';
  axios.post = async () => ({
    data: {
      choices: [{
        message: {
          content: '{reply: "Me dijo "sí: acepto"", actions: [], extractedFields: {}}'
        }
      }]
    }
  });
  console.warn = (...args) => warnings.push(args);

  try {
    const decision = await think({
      inboundText: 'ok',
      candidate: completeCandidate(),
      vacancy: schedulableVacancy(),
      recentMessages: [],
      currentStep: ConversationStep.COLLECTING_DATA
    });

    assert.equal(decision.fallback, true);
    assert.equal(decision.fallbackReason, 'invalid_engine_json');
    assert.equal(decision.raw, null);
    assert.equal(warnings[0][0], '[ENGINE_PARSE_FAIL]');
    assert.equal(warnings[0][1].parseStrategy, 'none');
  } finally {
    axios.post = originalPost;
    console.warn = originalWarn;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('parseEngineJson rechaza JSON reparado sin schema minimo para no persistir basura', () => {
  const parsed = parseEngineJson("{reply: 'Hola sin acciones', extractedFields: {documentNumber: '123'}}");

  assert.equal(parsed, null);
});

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

test('mark_rejected solo rechaza con evidencia real de incumplimiento de requisito y deja trazabilidad', async () => {
  const prisma = prismaMock();
  const candidate = completeCandidate({ age: 17, cvStorageKey: null, cvOriginalName: null, cvMimeType: null });
  const result = await act({
    prisma,
    candidate,
    vacancy: schedulableVacancy({ minAge: 18, maxAge: 45, schedulingEnabled: false }),
    actions: [{ type: 'mark_rejected', data: { reason: 'No cumple requisitos' } }]
  });

  const update = prisma.updates.at(-1).data;
  assert.equal(update.status, 'RECHAZADO');
  assert.match(update.rejectionReason, /edad/i);
  assert.match(update.rejectionDetails, /age_below_min/);
  assert.match(update.rejectionDetails, /Edad detectada: 17/);
  assert.equal(result.finalStep, ConversationStep.DONE);
});

test('mark_rejected sin evidencia suficiente queda bloqueado y no cambia estado', async () => {
  const prisma = prismaMock();
  const result = await act({
    prisma,
    candidate: completeCandidate({ age: 25 }),
    vacancy: schedulableVacancy({ minAge: 18, maxAge: 45 }),
    actions: [{ type: 'mark_rejected', data: { reason: 'No cumple requisitos' } }]
  });

  assert.equal(prisma.updates.some((update) => update.data.status === 'RECHAZADO'), false);
  assert.deepEqual(result.blockedActions, [{ action: 'mark_rejected', reason: 'missing_requirement_evidence' }]);
});

test('mark_rejected no convierte faltantes o advertencias geograficas en rechazo', async () => {
  const prisma = prismaMock();
  await act({
    prisma,
    candidate: completeCandidate({ locality: null, neighborhood: null, age: 25 }),
    vacancy: schedulableVacancy({ city: 'Bogotá' }),
    actions: [{ type: 'mark_rejected', data: { reason: 'Vive fuera de zona' } }]
  });

  assert.equal(prisma.updates.some((update) => update.data.status === 'RECHAZADO'), false);
});

test('Soacha se trata como ciudad valida y no como localidad bogotana', () => {
  const vacancy = schedulableVacancy({ city: 'Soacha', schedulingEnabled: false });
  const aligned = alignCandidateLocationFields({ locality: 'Soacha', neighborhood: null }, vacancy);

  assert.equal(vacancy.city, 'Soacha');
  assert.equal(aligned.neighborhood, 'Soacha Cundinamarca');
  assert.equal(aligned.locality, null);
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
  assert.equal(prisma.updates.some((update) => update.data.neighborhood === 'Soacha Cundinamarca'), true);
  assert.equal(result.finalStep, ConversationStep.ASK_CV);
});

test('act produce el mismo cierre, update y bloqueos con acciones equivalentes en distinto orden', async () => {
  const first = prismaMock();
  const second = prismaMock();
  const actionA = { type: 'mark_no_interest' };
  const actionB = { type: 'confirm_booking' };

  const resultA = await act({
    prisma: first,
    candidate: completeCandidate(),
    vacancy: schedulableVacancy(),
    nextSlot: nextSlot(),
    actions: [actionA, actionB]
  });
  const resultB = await act({
    prisma: second,
    candidate: completeCandidate(),
    vacancy: schedulableVacancy(),
    nextSlot: nextSlot(),
    actions: [actionB, actionA]
  });

  assert.equal(resultA.finalStep, resultB.finalStep);
  assert.deepEqual(first.stepUpdates.at(-1).data, second.stepUpdates.at(-1).data);
  assert.deepEqual(resultA.blockedActions, resultB.blockedActions);
});

test('mark_no_interest + confirm_booking nunca crea booking', async () => {
  for (const actions of [
    [{ type: 'mark_no_interest' }, { type: 'confirm_booking' }],
    [{ type: 'confirm_booking' }, { type: 'mark_no_interest' }]
  ]) {
    const prisma = prismaMock();
    const result = await act({
      prisma,
      candidate: completeCandidate(),
      vacancy: schedulableVacancy(),
      nextSlot: nextSlot(),
      actions
    });

    assert.equal(prisma.bookings.length, 0);
    assert.equal(result.finalStep, ConversationStep.DONE);
    assert.equal(result.stepTransition.contract, 'no_interest');
    assert.equal(prisma.stepUpdates.at(-1).data.currentStep, ConversationStep.DONE);
  }
});

test('pause_bot + offer_interview conserva la razon explicita de pausa como prioridad deterministica', async () => {
  for (const actions of [
    [{ type: 'pause_bot', data: { reason: 'Validacion manual de agenda' } }, { type: 'offer_interview' }],
    [{ type: 'offer_interview' }, { type: 'pause_bot', data: { reason: 'Validacion manual de agenda' } }]
  ]) {
    const prisma = prismaMock();
    await act({
      prisma,
      candidate: completeCandidate(),
      vacancy: schedulableVacancy(),
      nextSlot: null,
      actions
    });

    assert.equal(prisma.updates.at(-1).data.botPaused, true);
    assert.equal(prisma.updates.at(-1).data.botPauseReason, 'Validacion manual de agenda');
  }
});

test('save_fields se persiste independientemente del orden junto a cierre por no interes', async () => {
  for (const actions of [
    [{ type: 'save_fields', data: { medicalRestrictions: 'Ninguna' } }, { type: 'mark_no_interest' }],
    [{ type: 'mark_no_interest' }, { type: 'save_fields', data: { medicalRestrictions: 'Ninguna' } }]
  ]) {
    const prisma = prismaMock();
    await act({
      prisma,
      candidate: completeCandidate({ medicalRestrictions: null }),
      vacancy: schedulableVacancy(),
      actions
    });

    assert.equal(prisma.updates[0].data.medicalRestrictions, 'Sin restricciones médicas');
    assert.equal(prisma.stepUpdates.at(-1).data.currentStep, ConversationStep.DONE);
  }
});

test('candidata femenina nunca llega a SCHEDULING ni SCHEDULED aunque el modelo lo solicite', async () => {
  for (const requestedStep of [ConversationStep.SCHEDULING, ConversationStep.SCHEDULED]) {
    const prisma = prismaMock();
    const result = await act({
      prisma,
      candidate: completeCandidate({ gender: Gender.FEMALE }),
      vacancy: schedulableVacancy(),
      nextSlot: nextSlot(),
      actions: [{ type: requestedStep === ConversationStep.SCHEDULED ? 'confirm_booking' : 'offer_interview' }],
      nextStep: requestedStep
    });

    assert.notEqual(result.finalStep, requestedStep);
    assert.equal(prisma.updates.some((update) => update.data.currentStep === requestedStep), false);
    assert.equal(prisma.bookings.length, 0);
    assert.equal(prisma.updates.at(-1).data.botPaused, true);
  }
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

test('despues de rechazo emitido no repite automaticamente el mismo rechazo', async () => {
  const reply = 'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque la edad registrada no cumple el rango definido para esta vacante.';
  const decision = await thinkWithModelReply({
    inboundText: 'ok',
    reply,
    raw: { actions: [{ type: 'mark_rejected', data: { reason: 'No cumple requisitos' } }] },
    candidate: completeCandidate({
      status: 'RECHAZADO',
      rejectionReason: 'edad fuera del rango requerido para la vacante',
      rejectionDetails: 'age_below_min: Edad detectada: 17. Rango requerido: mínimo 18 años.'
    }),
    recentMessages: [
      { direction: 'OUTBOUND', body: reply, rawPayload: { source: 'conversation_engine', actions: [{ type: 'mark_rejected' }] } },
      { direction: 'INBOUND', body: 'ok' }
    ]
  });

  assert.equal(decision.rejectionMemoryApplied, true);
  assert.notEqual(decision.reply, reply);
  assert.deepEqual(decision.actions, []);
});

test('si candidato pregunta despues del rechazo responde con contexto sin repetir solo el rechazo', async () => {
  const reply = 'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque la edad registrada no cumple el rango definido para esta vacante.';
  const decision = await thinkWithModelReply({
    inboundText: '¿Entonces puedo aplicar más adelante?',
    reply,
    raw: {
      responsePurpose: 'answer_question',
      actions: [{ type: 'mark_rejected', data: { reason: 'No cumple requisitos' } }]
    },
    candidate: completeCandidate({
      status: 'RECHAZADO',
      rejectionReason: 'edad fuera del rango requerido para la vacante',
      rejectionDetails: 'age_below_min: Edad detectada: 17. Rango requerido: mínimo 18 años.'
    }),
    recentMessages: [
      { direction: 'OUTBOUND', body: reply, rawPayload: { source: 'conversation_engine', actions: [{ type: 'mark_rejected' }] } },
      { direction: 'INBOUND', body: '¿Entonces puedo aplicar más adelante?' }
    ]
  });

  assert.equal(decision.rejectionMemoryApplied, true);
  assert.notEqual(decision.reply, reply);
  assert.match(decision.reply, /registrada|requisito/i);
  assert.match(decision.reply, /duda|pregunta|vacante/i);
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

test('loop guard alterna variante determinística en activaciones consecutivas cuando hay alternativa', async () => {
  const repeatedReply = 'Para avanzar necesito que me compartas tu número de documento.';
  const first = await thinkWithModelReply({
    reply: repeatedReply,
    recentMessages: [
      { direction: 'OUTBOUND', body: repeatedReply, rawPayload: { source: 'conversation_engine' } },
      { direction: 'OUTBOUND', body: 'Compárteme tu número de documento para continuar.', rawPayload: { source: 'conversation_engine' } }
    ],
    candidate: completeCandidate({ documentNumber: null }),
    currentStep: ConversationStep.COLLECTING_DATA
  });

  const second = await thinkWithModelReply({
    reply: repeatedReply,
    recentMessages: [
      { direction: 'OUTBOUND', body: repeatedReply, rawPayload: { source: 'conversation_engine' } },
      { direction: 'OUTBOUND', body: 'Compárteme tu número de documento para continuar.', rawPayload: { source: 'conversation_engine' } },
      { direction: 'OUTBOUND', body: first.reply, rawPayload: { source: 'conversation_engine' } }
    ],
    candidate: completeCandidate({ documentNumber: null }),
    currentStep: ConversationStep.COLLECTING_DATA
  });

  assert.equal(first.loopGuardApplied, true);
  assert.equal(second.loopGuardApplied, true);
  assert.notEqual(second.reply, first.reply);
});

test('loop guard en ASK_CV siempre pide PDF/DOCX y nunca foto o imagen', async () => {
  const decision = await thinkWithModelReply({
    reply: 'Envíame tu HV en PDF o DOCX para seguir con el proceso.',
    raw: { responsePurpose: 'request_cv', actions: [{ type: 'request_cv' }] },
    recentMessages: [
      { direction: 'OUTBOUND', body: 'Envíame tu HV en PDF o DOCX para seguir con el proceso.', rawPayload: { source: 'conversation_engine', responsePurpose: 'request_cv', actions: [{ type: 'request_cv' }] } },
      { direction: 'OUTBOUND', body: 'Necesito adjuntar tu currículum en archivo PDF o Word antes de continuar.', rawPayload: { source: 'conversation_engine', responsePurpose: 'request_cv', actions: [{ type: 'request_cv' }] } }
    ],
    currentStep: ConversationStep.ASK_CV
  });

  assert.equal(decision.loopGuardApplied, true);
  assert.match(decision.reply, /PDF/i);
  assert.match(decision.reply, /DOCX|Word/i);
  assert.doesNotMatch(decision.reply, /foto|imagen/i);
});

test('loop guard sin vacante pide ciudad o vacante sin solicitar datos no permitidos', async () => {
  const decision = await thinkWithModelReply({
    reply: 'Para avanzar necesito que me compartas tus datos completos.',
    recentMessages: [
      { direction: 'OUTBOUND', body: 'Para avanzar necesito que me compartas tus datos completos.', rawPayload: { source: 'conversation_engine' } },
      { direction: 'OUTBOUND', body: 'Compárteme tus datos completos para continuar.', rawPayload: { source: 'conversation_engine' } }
    ],
    candidate: completeCandidate({ vacancyId: null }),
    currentStep: ConversationStep.COLLECTING_DATA
  });

  assert.equal(decision.loopGuardApplied, true);
  assert.match(decision.reply, /ciudad|vacante|cargo/i);
  assert.doesNotMatch(decision.reply, /documento|edad|restricciones|transporte|hoja de vida|HV/i);
});

test('loop guard variants son determinísticas y no hacen llamadas adicionales a OpenAI', async () => {
  const repeatedReply = 'Para avanzar necesito que me compartas tu número de documento.';
  const args = {
    reply: repeatedReply,
    recentMessages: [
      { direction: 'OUTBOUND', body: repeatedReply, rawPayload: { source: 'conversation_engine' } },
      { direction: 'OUTBOUND', body: 'Compárteme tu número de documento para continuar.', rawPayload: { source: 'conversation_engine' } }
    ],
    candidate: completeCandidate({ documentNumber: null }),
    currentStep: ConversationStep.COLLECTING_DATA
  };

  const first = await thinkWithModelReply(args);
  const second = await thinkWithModelReply(args);

  assert.equal(first.loopGuardApplied, true);
  assert.equal(second.loopGuardApplied, true);
  assert.equal(second.reply, first.reply);
});

test('loop guard variants incluyen microcontexto seguro sin inventar datos', async () => {
  const decision = await thinkWithModelReply({
    reply: 'Para avanzar necesito que me compartas tu número de documento.',
    recentMessages: [
      { direction: 'OUTBOUND', body: 'Para avanzar necesito que me compartas tu número de documento.', rawPayload: { source: 'conversation_engine' } },
      { direction: 'OUTBOUND', body: 'Compárteme tu número de documento para continuar.', rawPayload: { source: 'conversation_engine' } }
    ],
    candidate: completeCandidate({ documentNumber: null, age: null, vacancyId: 10 }),
    currentStep: ConversationStep.COLLECTING_DATA
  });

  assert.equal(decision.loopGuardApplied, true);
  assert.match(decision.reply, /documento|edad/i);
  assert.doesNotMatch(decision.reply, /entrevista|agendada|Bogotá|Loginpro/i);
});

test('Bogotá como residencia sin localidad válida mantiene pendiente pedir localidad', () => {
  const vacancy = schedulableVacancy({ city: 'Bogotá' });
  const aligned = alignCandidateLocationFields({ locality: 'Bogotá' }, vacancy);

  assert.equal(aligned.locality, null);
  assert.equal(aligned.neighborhood, null);
});

test('Soacha en vacante Bogotá se guarda como municipio y no queda pendiente localidad bogotana', async () => {
  const vacancy = schedulableVacancy({ city: 'Bogotá', schedulingEnabled: false });
  const prisma = prismaMock();
  const candidate = completeCandidate({ locality: null, neighborhood: null, cvStorageKey: null, cvOriginalName: null, cvMimeType: null });

  const result = await act({
    actions: [{ type: 'save_fields', data: { neighborhood: 'Vivo en Soacha' } }],
    candidate,
    vacancy,
    extractedFields: {},
    nextStep: ConversationStep.COLLECTING_DATA,
    prisma
  });

  assert.ok(prisma.updates.some((update) => update.data.neighborhood === 'Soacha Cundinamarca'));
  assert.equal(result.readiness.missingFields.includes('locality'), false);
});

test('vacante Montevideo Bogotá no rechaza ni bloquea residencia en Soacha', async () => {
  const vacancy = schedulableVacancy({
    city: 'Bogotá',
    title: 'Auxiliar Cargue y Descargue Montevideo',
    operation: { name: 'Montevideo', city: { name: 'Bogotá' } },
    schedulingEnabled: false
  });
  const prisma = prismaMock();
  const candidate = completeCandidate({ locality: null, neighborhood: null, cvStorageKey: null, cvOriginalName: null, cvMimeType: null });

  const result = await act({
    actions: [{ type: 'save_fields', data: { neighborhood: 'Soacha' } }, { type: 'request_cv' }],
    candidate,
    vacancy,
    extractedFields: {},
    nextStep: ConversationStep.ASK_CV,
    prisma
  });

  assert.equal(result.blockedActions.some((item) => String(item.reason || '').includes('rejected')), false);
  assert.equal(prisma.updates.some((update) => update.data.status === 'RECHAZADO'), false);
  assert.equal(result.finalStep, ConversationStep.ASK_CV);
});

test('vacante Siberia advierte por residencia lejana sin rechazar automáticamente', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalPost = axios.post;
  process.env.OPENAI_API_KEY = 'test-key';
  axios.post = async () => ({
    data: { choices: [{ message: { content: JSON.stringify({ reply: 'Compárteme tu hoja de vida en PDF o Word/DOCX.', nextStep: ConversationStep.ASK_CV, actions: [{ type: 'request_cv' }], extractedFields: {} }) } }] }
  });

  try {
    const decision = await think({
      inboundText: 'listo',
      candidate: completeCandidate({ locality: null, neighborhood: 'Soacha Cundinamarca' }),
      vacancy: schedulableVacancy({ title: 'Auxiliar de Bodega Siberia', operationAddress: 'Parque industrial Siberia' }),
      recentMessages: [],
      currentStep: ConversationStep.COLLECTING_DATA
    });

    assert.match(decision.reply, /traslado hacia Siberia puede ser exigente/i);
    assert.match(decision.reply, /No te descarto/i);
    assert.equal(decision.actions.some((action) => action.type === 'mark_rejected'), false);
  } finally {
    axios.post = originalPost;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('vacante Siberia no advierte para Funza o Mosquera y no repite advertencia ya enviada', async () => {
  const baseReply = 'Seguimos con el proceso.';
  const originalKey = process.env.OPENAI_API_KEY;
  const originalPost = axios.post;
  process.env.OPENAI_API_KEY = 'test-key';
  axios.post = async () => ({
    data: { choices: [{ message: { content: JSON.stringify({ reply: baseReply, nextStep: ConversationStep.COLLECTING_DATA, actions: [{ type: 'nothing' }], extractedFields: {} }) } }] }
  });

  try {
    const vacancy = schedulableVacancy({ title: 'Auxiliar de Bodega Siberia', operationAddress: 'Siberia' });
    const funza = await think({ inboundText: 'ok', candidate: completeCandidate({ locality: null, neighborhood: 'Funza Cundinamarca' }), vacancy, recentMessages: [], currentStep: ConversationStep.COLLECTING_DATA });
    const mosquera = await think({ inboundText: 'ok', candidate: completeCandidate({ locality: null, neighborhood: 'Mosquera Cundinamarca' }), vacancy, recentMessages: [], currentStep: ConversationStep.COLLECTING_DATA });
    const repeated = await think({
      inboundText: 'sí quiero seguir',
      candidate: completeCandidate({ locality: null, neighborhood: 'Soacha Cundinamarca' }),
      vacancy,
      recentMessages: [{ direction: 'OUTBOUND', body: 'Te aviso con cuidado: el traslado hacia Siberia puede ser exigente desde tu zona. No te descarto por eso; si para ti es viable continuar, seguimos con el proceso.' }],
      currentStep: ConversationStep.COLLECTING_DATA
    });

    assert.equal(funza.reply, baseReply);
    assert.equal(mosquera.reply, baseReply);
    assert.equal(repeated.reply, baseReply);
  } finally {
    axios.post = originalPost;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('flujo flexible: si la HV ya llegó al inicio, act guarda datos fuera de orden y pide solo faltantes antes de cerrar', async () => {
  const prisma = prismaMock();
  const candidate = completeCandidate({
    currentStep: ConversationStep.GREETING_SENT,
    fullName: null,
    documentType: null,
    documentNumber: null,
    age: null,
    locality: null,
    medicalRestrictions: null,
    transportMode: null,
    cvStorageKey: 'cv/temprana.pdf',
    cvOriginalName: 'hv.pdf',
    cvMimeType: 'application/pdf'
  });

  const result = await act({
    prisma,
    candidate,
    vacancy: schedulableVacancy({ schedulingEnabled: false }),
    actions: [{ type: 'save_fields', data: { fullName: 'Laura Medina', age: 28, transportMode: 'Moto' } }],
    nextStep: ConversationStep.DONE
  });

  assert.equal(prisma.updates[0].data.fullName, 'Laura Medina');
  assert.equal(prisma.updates[0].data.age, 28);
  assert.equal(prisma.updates[0].data.transportMode, 'Moto');
  assert.equal(result.finalStep, ConversationStep.COLLECTING_DATA);
  assert.deepEqual(result.blockedActions, [{ action: 'model_next_step', reason: 'done_blocked:documentType,documentNumber,locality,medicalRestrictions' }]);
});

test('flujo flexible: con solo uno o dos datos faltantes no reinicia formulario ni pide HV ya existente', async () => {
  const prisma = prismaMock();
  const candidate = completeCandidate({
    currentStep: ConversationStep.COLLECTING_DATA,
    documentNumber: null,
    medicalRestrictions: null,
    cvStorageKey: 'cv/temprana.pdf',
    cvOriginalName: 'hv.pdf',
    cvMimeType: 'application/pdf'
  });

  const result = await act({
    prisma,
    candidate,
    vacancy: schedulableVacancy({ schedulingEnabled: false }),
    actions: [{ type: 'request_cv' }],
    nextStep: ConversationStep.ASK_CV
  });

  assert.equal(result.finalStep, ConversationStep.COLLECTING_DATA);
  assert.deepEqual(result.readiness.missingFields, ['documentNumber', 'medicalRestrictions']);
  assert.equal(prisma.updates.at(-1)?.data.currentStep, undefined);
});

test('flujo flexible: una pregunta de vacante en medio del flujo puede responderse y retomar faltantes sin activar loop guard', async () => {
  const reply = 'El salario registrado para esta vacante es $1.500.000. Para seguir, confírmame por favor tu número de documento.';
  const decision = await thinkWithModelReply({
    inboundText: '¿cuánto pagan? y mi transporte es moto',
    reply,
    raw: {
      responsePurpose: 'answer_vacancy_question_and_collect_missing_data',
      detectedIntent: 'vacancy_question_with_data',
      actions: [{ type: 'save_fields', data: { transportMode: 'Moto' } }],
      extractedFields: { transportMode: 'Moto' }
    },
    recentMessages: [
      { direction: 'OUTBOUND', body: reply, rawPayload: { source: 'conversation_engine' } },
      { direction: 'INBOUND', body: '¿cuánto pagan? y mi transporte es moto' }
    ],
    candidate: completeCandidate({ documentNumber: null, transportMode: null }),
    currentStep: ConversationStep.COLLECTING_DATA
  });

  assert.equal(decision.reply, reply);
  assert.equal(decision.loopGuardApplied, false);
  assert.equal(decision.extractedFields.transportMode, 'Moto');
});

test('flujo flexible: candidato registrado y completo no vuelve a COLLECTING_DATA por nextStep del modelo', async () => {
  const prisma = prismaMock();
  const candidate = completeCandidate({
    currentStep: ConversationStep.DONE,
    status: 'REGISTRADO'
  });

  const result = await act({
    prisma,
    candidate,
    vacancy: schedulableVacancy({ schedulingEnabled: false }),
    actions: [{ type: 'nothing' }],
    nextStep: ConversationStep.COLLECTING_DATA
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(prisma.updates.some((update) => update.data.currentStep === ConversationStep.COLLECTING_DATA), false);
});

test('prompt del engine define a Lorren como reclutadora de LoginPro Service y no permite inventar datos sensibles', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalPost = axios.post;
  process.env.OPENAI_API_KEY = 'test-key';
  let systemPrompt = '';
  axios.post = async (_url, payload) => {
    systemPrompt = payload?.messages?.[0]?.content || '';
    return {
      data: {
        choices: [{
          message: {
            content: JSON.stringify({
              reply: 'No tengo ese dato registrado en la vacante.',
              nextStep: ConversationStep.COLLECTING_DATA,
              actions: [{ type: 'nothing' }],
              extractedFields: {}
            })
          }
        }]
      }
    };
  };

  try {
    await think({
      inboundText: '¿Quién eres y qué salario tiene?',
      candidate: completeCandidate(),
      vacancy: schedulableVacancy({ title: 'Auxiliar logístico', conditions: 'Turnos rotativos registrados' }),
      recentMessages: [],
      currentStep: ConversationStep.COLLECTING_DATA
    });
  } finally {
    axios.post = originalPost;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }

  assert.match(systemPrompt, /Sos Lórren, reclutadora de LoginPro Service/i);
  assert.match(systemPrompt, /cargo, salario, horarios, beneficios, requisitos, direccion, condiciones y documentacion de entrevista/i);
  assert.match(systemPrompt, /Si el dato no esta registrado en la vacante asignada, dilo claramente y no lo inventes/i);
});
