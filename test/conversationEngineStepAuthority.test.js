import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ConversationStep, Gender } from '@prisma/client';
import { act } from '../src/services/conversationEngine.js';

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

test('una transición compuesta conserva temporalmente su escritura unida', async () => {
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
  assert.equal(result.stepTransition, null);
  assert.equal(prisma.calls.updateMany.length, 0);
  assert.equal(prisma.calls.update.length, 1);
  assert.deepEqual(prisma.calls.update[0].data, {
    reminderScheduledFor: null,
    reminderState: 'SKIPPED',
    currentStep: ConversationStep.DONE
  });
});

test('chatEngine suprime la respuesta calculada sobre un paso obsoleto', () => {
  const source = fs.readFileSync('src/services/chatEngine.js', 'utf8');
  assert.match(source, /staleStepConflict/);
  assert.match(source, /effectiveReply\s*=\s*staleStepConflict\s*\?\s*null/);
  assert.match(source, /suppressedReason:\s*staleStepConflict\s*\?\s*'stale_candidate_step'/);
});
