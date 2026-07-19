import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, Gender, ReminderState } from '@prisma/client';
import { act } from '../src/services/conversationEngine.js';

function matchesDate(actual, expected) {
  if (expected === null) return actual === null;
  const date = actual instanceof Date ? actual : new Date(actual);
  return date >= expected.gte && date < expected.lt;
}

function candidate(overrides = {}) {
  return {
    id: 'candidate-engine-pause-1',
    vacancyId: 'vacancy-1',
    currentStep: ConversationStep.ASK_CV,
    status: 'REGISTRADO',
    fullName: 'Carlos Pérez',
    documentType: 'CC',
    documentNumber: '1000000001',
    age: 28,
    medicalRestrictions: 'Sin restricciones medicas',
    transportMode: 'Bus',
    locality: 'Suba',
    gender: Gender.MALE,
    cvStorageKey: 'cv/candidate-engine-pause-1.pdf',
    cvOriginalName: 'hoja-de-vida.pdf',
    cvMimeType: 'application/pdf',
    botPaused: false,
    botPausedAt: null,
    botPausedBy: null,
    botPauseReason: null,
    botResumeMode: null,
    reminderScheduledFor: new Date('2026-07-22T14:00:00.000Z'),
    reminderState: ReminderState.SCHEDULED,
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
  const calls = { update: [], updateMany: [], findUnique: [], bookings: [] };
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
        const where = args.where || {};
        const matches = state.id === where.id
          && (!Object.hasOwn(where, 'botPaused') || state.botPaused === where.botPaused)
          && (!Object.hasOwn(where, 'botPausedAt') || matchesDate(state.botPausedAt, where.botPausedAt))
          && (!Object.hasOwn(where, 'botPausedBy') || state.botPausedBy === where.botPausedBy)
          && (!Object.hasOwn(where, 'botPauseReason') || state.botPauseReason === where.botPauseReason)
          && (!Object.hasOwn(where, 'botResumeMode') || state.botResumeMode === where.botResumeMode)
          && (!Object.hasOwn(where, 'reminderScheduledFor') || matchesDate(state.reminderScheduledFor, where.reminderScheduledFor))
          && (!Object.hasOwn(where, 'reminderState') || state.reminderState === where.reminderState)
          && (!Object.hasOwn(where, 'currentStep') || state.currentStep === where.currentStep);
        if (!matches) return { count: 0 };
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
      create: async (args) => {
        calls.bookings.push(args);
        return { id: 'booking-1', ...args.data };
      }
    }
  };
}

test('pause_bot exacto delega por compare-and-set', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);
  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'pause_bot', data: { reason: 'Validación humana necesaria' } }],
    nextStep: snapshot.currentStep
  });

  assert.equal(result.stepTransition.contract, 'explicit_pause');
  assert.equal(result.stepTransition.count, 1);
  assert.equal(result.stepTransition.conflict, false);
  assert.equal(prisma.calls.updateMany.length, 1);
  assert.equal(prisma.calls.update.length, 0);
  assert.deepEqual(Object.keys(prisma.calls.updateMany[0].data).sort(), [
    'botPauseReason',
    'botPaused',
    'botPausedAt',
    'reminderScheduledFor',
    'reminderState'
  ]);
  assert.equal(prisma.getState().botPaused, true);
  assert.equal(prisma.getState().reminderState, ReminderState.CANCELLED);
});

test('una carrera de pausa conserva el estado vigente y marca conflicto', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(candidate({ botPauseReason: 'Cambio concurrente' }));
  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'pause_bot', data: { reason: 'Validación humana necesaria' } }],
    nextStep: snapshot.currentStep
  });

  assert.equal(result.stepTransition.contract, 'explicit_pause');
  assert.equal(result.stepTransition.count, 0);
  assert.equal(result.stepTransition.conflict, true);
  assert.equal(prisma.calls.update.length, 0);
  assert.equal(prisma.getState().botPauseReason, 'Cambio concurrente');
});

test('pause_bot con cambio de paso permanece fuera del contrato', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);
  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'pause_bot', data: { reason: 'Validación humana necesaria' } }],
    nextStep: ConversationStep.DONE
  });

  assert.equal(result.stepTransition, null);
  assert.equal(prisma.calls.updateMany.length, 0);
  assert.equal(prisma.calls.update.length, 1);
  assert.equal(prisma.calls.update[0].data.currentStep, ConversationStep.DONE);
  assert.equal(prisma.calls.update[0].data.botPaused, true);
});

test('pause_bot combinado con agenda permanece fuera del contrato', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);
  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy({ schedulingEnabled: true }),
    actions: [
      { type: 'pause_bot', data: { reason: 'Revisión manual de agenda' } },
      { type: 'offer_interview' }
    ],
    nextSlot: null,
    nextStep: snapshot.currentStep
  });

  assert.equal(result.stepTransition, null);
  assert.equal(prisma.calls.updateMany.length, 0);
  assert.equal(prisma.calls.update.length, 1);
  assert.equal(prisma.calls.update[0].data.botPaused, true);
  assert.equal(result.blockedActions[0].action, 'offer_interview');
});

test('pause_bot combinado con rechazo permanece fuera del contrato', async () => {
  const snapshot = candidate({ age: 17, cvStorageKey: null, cvOriginalName: null, cvMimeType: null });
  const prisma = createPrismaHarness(snapshot);
  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy({ minAge: 18 }),
    actions: [
      { type: 'pause_bot', data: { reason: 'Revisión manual' } },
      { type: 'mark_rejected', data: { reason: 'No cumple requisitos' } }
    ],
    nextStep: snapshot.currentStep
  });

  assert.notEqual(result.stepTransition?.contract, 'explicit_pause');
  assert.equal(prisma.calls.updateMany.some((call) => call.data?.botPaused === true), false);
  assert.equal(prisma.calls.update.length, 1);
  assert.equal(prisma.calls.update[0].data.botPaused, true);
});

test('pause_bot con razón compuesta solo por espacios usa el fallback canónico', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);
  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'pause_bot', data: { reason: '   ' } }],
    nextStep: snapshot.currentStep
  });

  assert.equal(result.stepTransition.contract, 'explicit_pause');
  assert.equal(result.stepTransition.count, 1);
  assert.equal(prisma.calls.updateMany[0].data.botPauseReason, 'Requiere atencion humana');
});

test('error vacío del contrato usa el código de fallback canónico', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);
  prisma.candidate.updateMany = async () => {
    throw new Error('   ');
  };

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'pause_bot', data: { reason: 'Revisión humana' } }],
    nextStep: snapshot.currentStep
  });

  assert.equal(result.stepTransition.contract, 'explicit_pause');
  assert.equal(result.stepTransition.count, 0);
  assert.equal(result.stepTransition.conflict, true);
  assert.equal(result.stepTransition.error, 'candidate_engine_pause_error');
});
