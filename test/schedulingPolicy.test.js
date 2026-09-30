import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulingPolicy } from '../src/core/engine/policies/schedulingPolicy.js';

function input(overrides = {}) {
  return {
    turn: { rawText: '' },
    candidate: { facts: { dataConsentStatus: 'ACCEPTED' } },
    vacancy: { schedulingEnabled: true },
    interpretation: { intent: null },
    pending: { fields: [], actions: [] },
    ...overrides
  };
}

const slot = Object.freeze({
  slotId: 'slot-1',
  startsAt: '2026-10-02T15:00:00.000Z',
  timezone: 'America/Bogota'
});

test('no agenda sin consentimiento aceptado ni en una vacante sin agenda', async () => {
  assert.deepEqual(await schedulingPolicy(input({
    candidate: { facts: { dataConsentStatus: 'PENDING' } },
    interpretation: { intent: 'BOOK_INTERVIEW', scheduling: { slot } }
  })), {});
  assert.deepEqual(await schedulingPolicy(input({
    vacancy: { schedulingEnabled: false },
    interpretation: { intent: 'BOOK_INTERVIEW', scheduling: { slot } }
  })), {});
});

test('reserva únicamente un slot estructurado y válido', async () => {
  assert.deepEqual(await schedulingPolicy(input({
    interpretation: { intent: 'BOOK_INTERVIEW', scheduling: { slot } }
  })), {
    scheduling: { action: 'reserve_slot', slot }
  });
});

test('una reprogramación sin slot solicita alternativas sin cerrar la reserva vigente', async () => {
  assert.deepEqual(await schedulingPolicy(input({
    interpretation: { intent: 'REQUEST_RESCHEDULE' }
  })), {
    scheduling: { action: 'suggest_slots' }
  });
});

test('la cancelación emite exclusivamente la acción declarativa de cancelación', async () => {
  assert.deepEqual(await schedulingPolicy(input({
    interpretation: { intent: 'CANCEL_INTERVIEW' }
  })), {
    scheduling: { action: 'cancel_booking' }
  });
});

test('una respuesta numérica selecciona de forma determinista un slot sugerido', async () => {
  const secondSlot = { ...slot, slotId: 'slot-2', startsAt: '2026-10-02T16:00:00.000Z' };
  assert.deepEqual(await schedulingPolicy(input({
    turn: { rawText: '2' },
    interpretation: { intent: 'ACKNOWLEDGEMENT' },
    pending: {
      fields: [],
      actions: [{
        type: 'suggested_slots',
        payload: { slots: [slot, secondSlot], timezone: 'America/Bogota' }
      }]
    }
  })), {
    scheduling: { action: 'reserve_slot', slot: secondSlot }
  });
});
