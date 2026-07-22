import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep, ReminderState } from '@prisma/client';
import { applyCandidateSilentProfileCapture } from '../src/services/candidateStateService.js';

const BASE_EXPECTED = Object.freeze({
  currentStep: ConversationStep.COLLECTING_DATA,
  vacancyId: null,
  botResumeMode: 'future_profile_capture',
  reminderScheduledFor: null,
  reminderState: ReminderState.NONE
});

function createClient({ count = 1, candidate = null } = {}) {
  const calls = { updateMany: [], findUnique: [] };
  return {
    calls,
    client: {
      candidate: {
        updateMany: async (args) => {
          calls.updateMany.push(args);
          return { count };
        },
        findUnique: async (args) => {
          calls.findUnique.push(args);
          return candidate || { id: args.where.id };
        }
      }
    }
  };
}

test('aplica perfil y progreso con snapshot dinámico de los campos objetivo', async () => {
  const observed = {
    id: 'candidate-silent-1',
    fullName: 'Ana Torres',
    age: 29,
    gender: 'FEMALE',
    currentStep: ConversationStep.GREETING_SENT,
    vacancyId: null,
    botResumeMode: 'future_profile_capture',
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED
  };
  const { client, calls } = createClient({ candidate: observed });

  const result = await applyCandidateSilentProfileCapture(client, {
    candidateId: 'candidate-silent-1',
    expected: {
      ...BASE_EXPECTED,
      fullName: null,
      age: null,
      gender: 'UNKNOWN'
    },
    update: {
      fullName: 'Ana Torres',
      age: 29,
      gender: 'FEMALE',
      currentStep: ConversationStep.GREETING_SENT,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });

  assert.equal(result.count, 1);
  assert.deepEqual(result.profileFields, ['fullName', 'age', 'gender']);
  assert.equal(calls.updateMany.length, 1);
  assert.equal(calls.updateMany[0].where.id, 'candidate-silent-1');
  assert.equal(calls.updateMany[0].where.currentStep, ConversationStep.COLLECTING_DATA);
  assert.equal(calls.updateMany[0].where.vacancyId, null);
  assert.equal(calls.updateMany[0].where.botResumeMode, 'future_profile_capture');
  assert.equal(calls.updateMany[0].where.fullName, null);
  assert.equal(calls.updateMany[0].where.age, null);
  assert.equal(calls.updateMany[0].where.gender, 'UNKNOWN');
  assert.equal(calls.updateMany[0].data.currentStep, ConversationStep.GREETING_SENT);
  assert.equal(calls.updateMany[0].data.reminderState, ReminderState.SKIPPED);
  assert.equal(result.candidate, observed);
});

test('conserva el modo alternativo cuando el productor lo incluye', async () => {
  const mode = 'alternative_vacancy_offer:vacancy-1';
  const { client, calls } = createClient();

  const result = await applyCandidateSilentProfileCapture(client, {
    candidateId: 'candidate-silent-2',
    expected: {
      ...BASE_EXPECTED,
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: mode,
      documentNumber: null
    },
    update: {
      documentNumber: '1234567890',
      currentStep: ConversationStep.GREETING_SENT,
      botResumeMode: mode,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });

  assert.equal(result.count, 1);
  assert.equal(calls.updateMany[0].where.botResumeMode, mode);
  assert.equal(calls.updateMany[0].data.botResumeMode, mode);
});

test('un conflicto devuelve el candidato vigente sin reintentar', async () => {
  const observed = {
    id: 'candidate-silent-3',
    fullName: 'Nombre más nuevo',
    currentStep: ConversationStep.ASK_CV,
    vacancyId: 'vacancy-new'
  };
  const { client, calls } = createClient({ count: 0, candidate: observed });

  const result = await applyCandidateSilentProfileCapture(client, {
    candidateId: 'candidate-silent-3',
    expected: { ...BASE_EXPECTED, fullName: null },
    update: {
      fullName: 'Nombre anterior',
      currentStep: ConversationStep.GREETING_SENT,
      reminderScheduledFor: null,
      reminderState: ReminderState.SKIPPED
    }
  });

  assert.equal(result.count, 0);
  assert.equal(result.candidate, observed);
  assert.equal(calls.updateMany.length, 1);
  assert.equal(calls.findUnique.length, 1);
});

test('rechaza vacante, modo, campos o efectos fuera del contrato', async () => {
  const { client, calls } = createClient();
  const validUpdate = {
    fullName: 'Ana Torres',
    currentStep: ConversationStep.GREETING_SENT,
    reminderScheduledFor: null,
    reminderState: ReminderState.SKIPPED
  };

  await assert.rejects(
    () => applyCandidateSilentProfileCapture(client, {
      candidateId: 'candidate-silent-4',
      expected: { ...BASE_EXPECTED, vacancyId: 'vacancy-1', fullName: null },
      update: validUpdate
    }),
    /candidate_silent_profile_capture_vacancy_must_be_null/
  );
  await assert.rejects(
    () => applyCandidateSilentProfileCapture(client, {
      candidateId: 'candidate-silent-4',
      expected: { ...BASE_EXPECTED, botResumeMode: 'manual_resume_dashboard', fullName: null },
      update: validUpdate
    }),
    /candidate_silent_profile_capture_mode_invalid/
  );
  await assert.rejects(
    () => applyCandidateSilentProfileCapture(client, {
      candidateId: 'candidate-silent-4',
      expected: BASE_EXPECTED,
      update: validUpdate
    }),
    /candidate_silent_profile_capture_expected_field_required:fullName/
  );
  await assert.rejects(
    () => applyCandidateSilentProfileCapture(client, {
      candidateId: 'candidate-silent-4',
      expected: { ...BASE_EXPECTED, fullName: null },
      update: { ...validUpdate, status: 'REGISTRADO' }
    }),
    /candidate_silent_profile_capture_update_field_not_allowed:status/
  );
  await assert.rejects(
    () => applyCandidateSilentProfileCapture(client, {
      candidateId: 'candidate-silent-4',
      expected: { ...BASE_EXPECTED, gender: 'UNKNOWN' },
      update: {
        gender: 'FEMALE',
        currentStep: ConversationStep.GREETING_SENT,
        reminderScheduledFor: null,
        reminderState: ReminderState.SKIPPED
      }
    }),
    /candidate_silent_profile_capture_material_profile_required/
  );
  await assert.rejects(
    () => applyCandidateSilentProfileCapture(client, {
      candidateId: 'candidate-silent-4',
      expected: { ...BASE_EXPECTED, fullName: null },
      update: { ...validUpdate, botResumeMode: 'future_profile_offer' }
    }),
    /candidate_silent_profile_capture_resume_mode_must_be_preserved/
  );

  assert.equal(calls.updateMany.length, 0);
});
