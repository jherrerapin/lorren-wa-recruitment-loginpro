import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStep } from '@prisma/client';
import { canScheduleReminder, isWithinWhatsappWindow, scheduleReminderForCandidate, cancelReminderOnInbound } from '../src/services/reminder.js';

test('canScheduleReminder permite estados pendientes y bloquea DONE/RECHAZADO', () => {
  const base = {
    status: 'NUEVO',
    currentStep: ConversationStep.COLLECTING_DATA,
    reminderState: 'NONE',
    lastInboundAt: new Date()
  };
  assert.equal(canScheduleReminder(base), true);
  assert.equal(canScheduleReminder({ ...base, currentStep: ConversationStep.DONE }), false);
  assert.equal(canScheduleReminder({ ...base, status: 'RECHAZADO' }), false);
});

test('isWithinWhatsappWindow valida ventana de 24 horas', () => {
  const recent = new Date(Date.now() - (23 * 60 * 60 * 1000));
  const old = new Date(Date.now() - (25 * 60 * 60 * 1000));
  assert.equal(isWithinWhatsappWindow(recent), true);
  assert.equal(isWithinWhatsappWindow(old), false);
});

test('scheduleReminderForCandidate agenda recordatorio único y cancelReminderOnInbound lo cancela', async () => {
  const state = {
    candidate: {
      id: 'cand-1',
      status: 'NUEVO',
      currentStep: ConversationStep.COLLECTING_DATA,
      reminderState: 'NONE',
      reminderScheduledFor: null,
      lastReminderAt: null,
      lastInboundAt: new Date()
    }
  };

  const prisma = {
    candidate: {
      async findUnique() {
        return { ...state.candidate };
      },
      async update({ data }) {
        state.candidate = { ...state.candidate, ...data };
        return { ...state.candidate };
      }
    }
  };

  await scheduleReminderForCandidate(prisma, 'cand-1', new Date('2026-04-02T12:00:00Z'));
  assert.equal(state.candidate.reminderState, 'SCHEDULED');
  assert.ok(state.candidate.reminderScheduledFor);

  await cancelReminderOnInbound(prisma, 'cand-1');
  assert.equal(state.candidate.reminderState, 'CANCELLED');
  assert.equal(state.candidate.reminderScheduledFor, null);
});
