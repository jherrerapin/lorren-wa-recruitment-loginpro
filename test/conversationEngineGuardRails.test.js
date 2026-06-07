import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, Gender } from '@prisma/client';
import { act, buildCandidateStateForModel } from '../src/services/conversationEngine.js';

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
