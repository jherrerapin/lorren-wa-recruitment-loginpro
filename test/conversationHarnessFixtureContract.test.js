import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderState } from '@prisma/client';
import { conversationCases } from './fixtures/conversationCases.js';

const validReminderStates = new Set(Object.values(ReminderState));

test('todos los candidatos del harness usan un ReminderState válido', () => {
  assert.ok(conversationCases.length > 0, 'el corpus conversacional no puede estar vacío');

  for (const conversationCase of conversationCases) {
    assert.ok(
      validReminderStates.has(conversationCase.candidate?.reminderState),
      `${conversationCase.id}: reminderState inválido ${conversationCase.candidate?.reminderState}`
    );
  }
});

test('el fixture no reintroduce el valor legacy PENDING', () => {
  for (const conversationCase of conversationCases) {
    assert.notEqual(
      conversationCase.candidate?.reminderState,
      'PENDING',
      `${conversationCase.id}: PENDING pertenece a DataConsentStatus, no a ReminderState`
    );
  }
});
