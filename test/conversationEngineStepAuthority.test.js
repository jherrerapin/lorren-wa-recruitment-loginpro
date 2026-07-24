import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ConversationStep, Gender, ReminderState } from '@prisma/client';
import { act, prepareEngineDecisionContext } from '../src/services/conversationEngine.js';
import { runChatEngine } from '../src/services/chatEngine.js';

function baseCandidate(overrides = {}) {
  return {
    id: 'candidate-engine-step-1',
    vacancyId: 'vacancy-1',
    currentStep: ConversationStep.COLLECTING_DATA,
    fullName: 'Carlos Pérez',
    documentType: 'CC',
    documentNumber: '1000000001',
    age: 28,
    medicalRestrictions: 'Sin restricciones medicas',
    transportMode: 'Bus',
    locality: 'Suba',
    gender: Gender.MALE,
    cvStorageKey: null,
    cvOriginalName: null,
    cvMimeType: null,
    reminderScheduledFor: null,
    reminderState: ReminderState.NONE,
    ...overrides
  };
}

function vacancy(overrides = {}) {
  return {
    id: 'vacancy-1',
    city: 'Bogotá',
    schedulingEnabled: false,
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

function createPrismaHarness(initialState) {
  let state = { ...initialState };
  const calls = { update: [], updateMany: [], findUnique: [] };

  return {
    calls,
    getState: () => ({ ...state }),
    candidate: {
      update: async (args) => {
        calls.update.push(args);
        state = { ...state, ...args.data };
        return { ...state };
      },
      updateMany: async (args) => {
        calls.updateMany.push(args);
        if (state.id !== args.where.id || state.currentStep !== args.where.currentStep) {
          return { count: 0 };
        }
        state = { ...state, ...args.data };
        return { count: 1 };
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return state.id === args.where.id ? { ...state } : null;
      }
    },
    interviewBooking: {
      findFirst: async () => null,
      updateMany: async () => ({ count: 0 }),
      create: async () => ({ id: 'booking-1' })
    }
  };
}

test('request_cv, request_confirmation y nextStep simple delegan por compare-and-set', async () => {
  const cases = [
    {
      name: 'request_cv',
      candidate: baseCandidate(),
      actions: [{ type: 'request_cv' }],
      nextStep: null,
      expectedStep: ConversationStep.ASK_CV
    },
    {
      name: 'request_confirmation',
      candidate: baseCandidate({ age: null }),
      actions: [{ type: 'request_confirmation' }],
      nextStep: null,
      expectedStep: ConversationStep.CONFIRMING_DATA
    },
    {
      name: 'model_next_step',
      candidate: baseCandidate({ currentStep: ConversationStep.MENU, fullName: null }),
      actions: [],
      nextStep: ConversationStep.GREETING_SENT,
      expectedStep: ConversationStep.GREETING_SENT
    }
  ];

  for (const item of cases) {
    const prisma = createPrismaHarness(item.candidate);
    const result = await act({
      prisma,
      candidate: item.candidate,
      vacancy: vacancy(),
      actions: item.actions,
      nextStep: item.nextStep
    });

    assert.equal(result.finalStep, item.expectedStep, item.name);
    assert.equal(result.stepTransition.count, 1, item.name);
    assert.equal(result.stepTransition.conflict, false, item.name);
    assert.equal(prisma.calls.updateMany.length, 1, item.name);
    assert.deepEqual(prisma.calls.updateMany[0], {
      where: {
        id: item.candidate.id,
        currentStep: item.candidate.currentStep
      },
      data: {
        currentStep: item.expectedStep
      }
    }, item.name);
    assert.equal(
      prisma.calls.update.some((call) => Object.hasOwn(call.data || {}, 'currentStep')),
      false,
      item.name
    );
  }
});

test('una carrera conserva el paso vigente y marca conflicto explícito', async () => {
  const snapshot = baseCandidate();
  const prisma = createPrismaHarness({
    ...snapshot,
    currentStep: ConversationStep.CONFIRMING_DATA
  });

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'request_cv' }]
  });

  assert.equal(result.requestedFinalStep, ConversationStep.ASK_CV);
  assert.equal(result.finalStep, ConversationStep.CONFIRMING_DATA);
  assert.equal(result.stepTransition.count, 0);
  assert.equal(result.stepTransition.conflict, true);
  assert.equal(result.stepTransition.observedStep, ConversationStep.CONFIRMING_DATA);
  assert.equal(prisma.calls.update.length, 0);
  assert.equal(prisma.getState().currentStep, ConversationStep.CONFIRMING_DATA);
});

test('mark_no_interest usa el primer contrato compuesto del engine', async () => {
  const candidate = baseCandidate({
    currentStep: ConversationStep.ASK_CV,
    cvStorageKey: 'cv/candidate-engine-step-1.pdf',
    cvOriginalName: 'hoja-de-vida.pdf',
    cvMimeType: 'application/pdf'
  });
  const prisma = createPrismaHarness(candidate);

  const result = await act({
    prisma,
    candidate,
    vacancy: vacancy(),
    actions: [{ type: 'mark_no_interest' }]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition.contract, 'no_interest');
  assert.equal(result.stepTransition.count, 1);
  assert.equal(prisma.calls.updateMany.length, 1);
  assert.equal(prisma.calls.update.length, 0);
  assert.deepEqual(prisma.calls.updateMany[0].data, {
    currentStep: ConversationStep.DONE,
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED
  });
});

test('chatEngine suprime la respuesta calculada sobre un paso obsoleto', () => {
  const source = fs.readFileSync('src/services/chatEngine.js', 'utf8');
  assert.match(source, /staleStepConflict/);
  assert.match(source, /effectiveReply\s*=\s*staleStepConflict\s*\?\s*null/);
  assert.match(source, /suppressedReason:\s*staleStepConflict\s*\?\s*['"]stale_candidate_step['"]/);
});


test('chatEngine reutiliza una decisión válida sin ejecutar un segundo think', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const candidate = baseCandidate();
    const currentVacancy = vacancy();
    const prisma = createPrismaHarness(candidate);
    const inboundText = 'continua con mi proceso';
    const preparedContext = await prepareEngineDecisionContext({
      prisma,
      candidate,
      vacancy: currentVacancy,
      inboundText,
      recentMessages: [],
      currentStep: candidate.currentStep
    });
    const plannedReply = 'Respuesta calculada una sola vez para este turno.';
    const result = await runChatEngine({
      prisma,
      candidate,
      vacancy: currentVacancy,
      inboundText,
      recentMessages: [],
      precomputedDecision: {
        reply: plannedReply,
        nextStep: candidate.currentStep,
        actions: [{ type: 'nothing' }],
        extractedFields: {},
        fallback: false,
        fallbackReason: null,
        loopGuardApplied: false,
        contextFingerprint: preparedContext.contextFingerprint,
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }
      }
    });

    assert.equal(result.reply, plannedReply);
    assert.equal(result.decisionReused, true);
    assert.equal(result.fallback, false);
    assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('chatEngine no reutiliza una decisión fallback', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const candidate = baseCandidate();
    const prisma = createPrismaHarness(candidate);
    const result = await runChatEngine({
      prisma,
      candidate,
      vacancy: vacancy(),
      inboundText: 'continua con mi proceso',
      recentMessages: [],
      precomputedDecision: {
        reply: 'NO_DEBE_REUTILIZARSE',
        nextStep: candidate.currentStep,
        actions: [{ type: 'nothing' }],
        extractedFields: {},
        fallback: true,
        fallbackReason: 'preview_failed',
        loopGuardApplied: false,
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
      }
    });

    assert.equal(result.decisionReused, false);
    assert.equal(result.fallback, true);
    assert.notEqual(result.reply, 'NO_DEBE_REUTILIZARSE');
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('webhook entrega la decisión previa y el engine valida la huella completa', () => {
  const webhookSource = fs.readFileSync('src/routes/webhook.js', 'utf8');
  const engineSource = fs.readFileSync('src/services/chatEngine.js', 'utf8');
  const plannerSource = fs.readFileSync('src/services/conversationEngine.js', 'utf8');
  assert.match(webhookSource, /prepareEngineDecisionContext/);
  assert.equal((webhookSource.match(/enginePreview: rawEnginePreview/g) || []).length, 2);
  assert.match(engineSource, /precomputedDecision\.contextFingerprint === preparedContext\.contextFingerprint/);
  assert.match(plannerSource, /createHash\('sha256'\)/);
  assert.match(plannerSource, /JSON\.stringify\(\{ systemPrompt, userPrompt \}\)/);
});

test('la huella cambia cuando cambia el historial o el slot', async () => {
  const candidate = baseCandidate();
  const currentVacancy = vacancy();
  const prisma = createPrismaHarness(candidate);
  const base = {
    prisma,
    candidate,
    vacancy: currentVacancy,
    inboundText: 'continua con mi proceso',
    currentStep: candidate.currentStep
  };
  const original = await prepareEngineDecisionContext({ ...base, recentMessages: [], nextSlot: null });
  const withHistory = await prepareEngineDecisionContext({
    ...base,
    recentMessages: [{ direction: 'OUTBOUND', body: 'Mensaje previo', rawPayload: { source: 'engine' } }],
    nextSlot: null
  });
  const withSlot = await prepareEngineDecisionContext({
    ...base,
    recentMessages: [],
    nextSlot: { slot: { id: 'slot-2' }, date: new Date('2026-08-01T15:00:00.000Z'), formattedDate: '1 de agosto' }
  });

  assert.notEqual(original.contextFingerprint, withHistory.contextFingerprint);
  assert.notEqual(original.contextFingerprint, withSlot.contextFingerprint);
});