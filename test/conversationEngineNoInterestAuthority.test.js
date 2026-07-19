import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, Gender, ReminderState } from '@prisma/client';
import { act } from '../src/services/conversationEngine.js';

function candidate(overrides = {}) {
  return {
    id: 'candidate-no-interest-engine-1',
    vacancyId: 'vacancy-1',
    currentStep: ConversationStep.ASK_CV,
    fullName: 'Carlos Pérez',
    documentType: 'CC',
    documentNumber: '1000000001',
    age: 28,
    medicalRestrictions: 'Sin restricciones medicas',
    transportMode: 'Bus',
    locality: 'Suba',
    gender: Gender.MALE,
    cvStorageKey: 'cv/candidate-no-interest-engine-1.pdf',
    cvOriginalName: 'hoja-de-vida.pdf',
    cvMimeType: 'application/pdf',
    reminderScheduledFor: new Date('2026-07-21T14:00:00.000Z'),
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

function nextSlot() {
  return {
    slot: { id: 'slot-1' },
    date: new Date('2026-07-22T14:00:00.000Z'),
    windowOk: true
  };
}

function matchesDateFilter(actual, expected) {
  if (expected === null) return actual === null;
  const actualDate = actual instanceof Date ? actual : new Date(actual);
  return actualDate >= expected.gte && actualDate < expected.lt;
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
        const matchesReminderDate = Object.hasOwn(where, 'reminderScheduledFor')
          ? matchesDateFilter(state.reminderScheduledFor, where.reminderScheduledFor)
          : true;
        const matches = state.id === where.id
          && (!Object.hasOwn(where, 'currentStep') || state.currentStep === where.currentStep)
          && (!Object.hasOwn(where, 'reminderState') || state.reminderState === where.reminderState)
          && matchesReminderDate;
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

test('mark_no_interest elegible delega el cierre compuesto por compare-and-set', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'mark_no_interest' }]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.requestedFinalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition.contract, 'no_interest');
  assert.equal(result.stepTransition.count, 1);
  assert.equal(result.stepTransition.conflict, false);
  assert.equal(prisma.calls.updateMany.length, 1);
  assert.equal(prisma.calls.update.length, 0);
  assert.deepEqual(prisma.calls.updateMany[0].data, {
    currentStep: ConversationStep.DONE,
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED
  });
});

test('una carrera del recordatorio conserva el estado vigente y marca conflicto', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(candidate({ reminderState: ReminderState.SENT }));

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'mark_no_interest' }]
  });

  assert.equal(result.requestedFinalStep, ConversationStep.DONE);
  assert.equal(result.finalStep, ConversationStep.ASK_CV);
  assert.equal(result.stepTransition.contract, 'no_interest');
  assert.equal(result.stepTransition.count, 0);
  assert.equal(result.stepTransition.conflict, true);
  assert.equal(result.stepTransition.observedStep, ConversationStep.ASK_CV);
  assert.equal(prisma.calls.update.length, 0);
  assert.equal(prisma.getState().reminderState, ReminderState.SENT);
  assert.notEqual(prisma.getState().currentStep, ConversationStep.DONE);
});

test('candidato incompleto conserva la guarda actual y no usa el contrato terminal', async () => {
  const snapshot = candidate({
    currentStep: ConversationStep.COLLECTING_DATA,
    cvStorageKey: null,
    cvOriginalName: null,
    cvMimeType: null
  });
  const prisma = createPrismaHarness(snapshot);

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'mark_no_interest' }]
  });

  assert.equal(result.finalStep, ConversationStep.ASK_CV);
  assert.equal(result.stepTransition, null);
  assert.equal(prisma.calls.updateMany.length, 0);
  assert.equal(prisma.calls.update.length, 1);
  assert.deepEqual(prisma.calls.update[0].data, {
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED,
    currentStep: ConversationStep.ASK_CV
  });
});

test('mark_no_interest bloquea confirm_booking y delega sin crear reserva', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy({ schedulingEnabled: true }),
    nextSlot: nextSlot(),
    actions: [{ type: 'confirm_booking' }, { type: 'mark_no_interest' }]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition.contract, 'no_interest');
  assert.equal(prisma.calls.bookings.length, 0);
  assert.deepEqual(result.blockedActions, [{ action: 'confirm_booking', reason: 'blocked_by_terminal_action' }]);
});

test('combinación con pause_bot permanece fuera del contrato de falta de interés', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [
      { type: 'mark_no_interest' },
      { type: 'pause_bot', data: { reason: 'Revisión humana' } }
    ]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition, null);
  assert.equal(prisma.calls.updateMany.length, 0);
  assert.equal(prisma.calls.update.length, 1);
  assert.equal(prisma.calls.update[0].data.botPaused, true);
  assert.equal(prisma.calls.update[0].data.botPauseReason, 'Revisión humana');
  assert.equal(prisma.calls.update[0].data.currentStep, ConversationStep.DONE);
});
