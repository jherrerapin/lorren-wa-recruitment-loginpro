import test from 'node:test';
import assert from 'node:assert/strict';
import { CandidateStatus, ConversationStep, Gender, ReminderState } from '@prisma/client';
import { act } from '../src/services/conversationEngine.js';

function candidate(overrides = {}) {
  return {
    id: 'candidate-rejection-engine-1',
    vacancyId: 'vacancy-1',
    currentStep: ConversationStep.ASK_CV,
    status: CandidateStatus.REGISTRADO,
    rejectionReason: null,
    rejectionDetails: null,
    fullName: 'Carlos Pérez',
    documentType: 'CC',
    documentNumber: '1000000001',
    age: 17,
    medicalRestrictions: 'Sin restricciones medicas',
    transportMode: 'Bus',
    locality: 'Suba',
    gender: Gender.MALE,
    cvStorageKey: 'cv/candidate-rejection-engine-1.pdf',
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
    minAge: 18,
    maxAge: 45,
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
          && (!Object.hasOwn(where, 'status') || state.status === where.status)
          && (!Object.hasOwn(where, 'rejectionReason') || state.rejectionReason === where.rejectionReason)
          && (!Object.hasOwn(where, 'rejectionDetails') || state.rejectionDetails === where.rejectionDetails)
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

test('mark_rejected elegible delega el cierre compuesto por compare-and-set', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'mark_rejected', data: { reason: 'No cumple requisitos' } }]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.requestedFinalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition.contract, 'requirement_rejection');
  assert.equal(result.stepTransition.count, 1);
  assert.equal(result.stepTransition.conflict, false);
  assert.equal(prisma.calls.updateMany.length, 1);
  assert.equal(prisma.calls.update.length, 0);
  assert.equal(prisma.calls.updateMany[0].data.status, CandidateStatus.RECHAZADO);
  assert.equal(prisma.calls.updateMany[0].data.currentStep, ConversationStep.DONE);
  assert.match(prisma.calls.updateMany[0].data.rejectionReason, /edad/i);
  assert.match(prisma.calls.updateMany[0].data.rejectionDetails, /age_below_min/);
  assert.equal(prisma.calls.updateMany[0].data.reminderScheduledFor, null);
  assert.equal(prisma.calls.updateMany[0].data.reminderState, ReminderState.SKIPPED);
});

test('una carrera por status conserva el estado vigente y marca conflicto', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(candidate({ status: CandidateStatus.CONTACTADO }));

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'mark_rejected' }]
  });

  assert.equal(result.requestedFinalStep, ConversationStep.DONE);
  assert.equal(result.finalStep, ConversationStep.ASK_CV);
  assert.equal(result.stepTransition.contract, 'requirement_rejection');
  assert.equal(result.stepTransition.count, 0);
  assert.equal(result.stepTransition.conflict, true);
  assert.equal(result.stepTransition.observedStep, ConversationStep.ASK_CV);
  assert.equal(prisma.calls.update.length, 0);
  assert.equal(prisma.getState().status, CandidateStatus.CONTACTADO);
});

test('una carrera por rechazo previo conserva razón y detalle vigentes', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(candidate({
    rejectionReason: 'Revisión humana',
    rejectionDetails: 'Evidencia posterior'
  }));

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'mark_rejected' }]
  });

  assert.equal(result.stepTransition.contract, 'requirement_rejection');
  assert.equal(result.stepTransition.conflict, true);
  assert.equal(prisma.getState().rejectionReason, 'Revisión humana');
  assert.equal(prisma.getState().rejectionDetails, 'Evidencia posterior');
});

test('mark_rejected sin evidencia suficiente conserva la guarda actual y no delega', async () => {
  const snapshot = candidate({ age: 25 });
  const prisma = createPrismaHarness(snapshot);

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'mark_rejected', data: { reason: 'No cumple requisitos' } }]
  });

  assert.equal(result.stepTransition, null);
  assert.equal(prisma.calls.updateMany.length, 0);
  assert.equal(prisma.calls.update.length, 0);
  assert.deepEqual(result.blockedActions, [{ action: 'mark_rejected', reason: 'missing_requirement_evidence' }]);
  assert.equal(prisma.getState().status, CandidateStatus.REGISTRADO);
});

test('mark_rejected bloquea confirm_booking y no crea reserva', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy({ schedulingEnabled: true }),
    nextSlot: nextSlot(),
    actions: [{ type: 'confirm_booking' }, { type: 'mark_rejected' }]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition.contract, 'requirement_rejection');
  assert.equal(prisma.calls.bookings.length, 0);
  assert.deepEqual(result.blockedActions, [{ action: 'confirm_booking', reason: 'blocked_by_terminal_action' }]);
});

test('combinación con pause_bot permanece fuera del contrato de rechazo', async () => {
  const snapshot = candidate();
  const prisma = createPrismaHarness(snapshot);

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [
      { type: 'mark_rejected' },
      { type: 'pause_bot', data: { reason: 'Revisión humana' } }
    ]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition, null);
  assert.equal(prisma.calls.updateMany.length, 0);
  assert.equal(prisma.calls.update.length, 1);
  assert.equal(prisma.calls.update[0].data.status, CandidateStatus.RECHAZADO);
  assert.equal(prisma.calls.update[0].data.botPaused, true);
  assert.equal(prisma.calls.update[0].data.botPauseReason, 'Revisión humana');
  assert.equal(prisma.calls.update[0].data.reminderState, ReminderState.CANCELLED);
});

test('candidato en DONE pero aún no rechazado usa el contrato sin requerir cambio de paso', async () => {
  const snapshot = candidate({ currentStep: ConversationStep.DONE });
  const prisma = createPrismaHarness(snapshot);

  const result = await act({
    prisma,
    candidate: snapshot,
    vacancy: vacancy(),
    actions: [{ type: 'mark_rejected' }]
  });

  assert.equal(result.finalStep, ConversationStep.DONE);
  assert.equal(result.requestedFinalStep, ConversationStep.DONE);
  assert.equal(result.stepTransition.contract, 'requirement_rejection');
  assert.equal(result.stepTransition.count, 1);
  assert.equal(prisma.calls.updateMany.length, 1);
  assert.equal(prisma.calls.update.length, 0);
});
