import test from 'node:test';
import assert from 'node:assert/strict';
import { consentPolicy } from '../src/core/engine/policies/consentPolicy.js';

function turn(rawText, { status = null, pending = false, interpretation } = {}) {
  return {
    turn: { rawText },
    candidate: { facts: { dataConsentStatus: status } },
    pending: { fields: pending ? ['dataConsent'] : [] },
    ...(interpretation ? { interpretation } : {})
  };
}

test('solicita el texto y las opciones legacy cuando el consentimiento está pendiente', () => {
  const decision = consentPolicy(turn('Me interesa', { status: 'PENDING' }));
  assert.match(decision.reply.text, /Autorizo a LoginPro a tratar mis datos personales, hoja de vida y documentos/);
  assert.deepEqual(decision.reply.interactiveOptions, [
    { id: 'data_consent:lorren-v2-2026-07-v3:accept', label: 'Sí autorizo' },
    { id: 'data_consent:lorren-v2-2026-07-v3:reject', label: 'No autorizo' }
  ]);
  assert.deepEqual(decision.mutations, { nextStep: 'AWAITING_DATA_CONSENT' });
  assert.deepEqual(decision.transitions, { keepCurrentStep: false });
});

test('un sí breve solo acepta si el consentimiento estaba pendiente', () => {
  assert.deepEqual(consentPolicy(turn('Sí')), {});
  assert.deepEqual(consentPolicy(turn('Sí', { pending: true })), {
    mutations: { fieldsToPersist: { dataConsentStatus: 'ACCEPTED' } }
  });
});

test('una autorización explícita acepta y no confunde preguntas o aceptación de vacante', () => {
  assert.deepEqual(consentPolicy(turn('Sí, autorizo el tratamiento de mis datos')), {
    mutations: { fieldsToPersist: { dataConsentStatus: 'ACCEPTED' } }
  });
  for (const text of ['Si autorizo qué pasa?', '¿Si autorizo qué harán con mis datos?', 'Acepto la vacante']) {
    assert.equal(consentPolicy(turn(text, { pending: true })).mutations.nextStep, 'AWAITING_DATA_CONSENT', text);
  }
});

test('el rechazo o la revocación explícitos cierran con la despedida legacy', () => {
  for (const input of [
    turn('No', { pending: true }),
    turn('No autorizo el tratamiento de mis datos'),
    turn('Revoco mi consentimiento', { status: 'ACCEPTED' })
  ]) {
    assert.deepEqual(consentPolicy(input), {
      reply: {
        text: 'Entendido. No continuaré con la postulación por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.',
        interactiveOptions: []
      },
      transitions: { endConversation: true }
    });
  }
});

test('no confunde el rechazo de la vacante ni una pregunta sobre derechos con revocación', () => {
  for (const text of ['No acepto la vacante', '¿Cómo puedo revocar mi consentimiento más adelante?']) {
    assert.equal(consentPolicy(turn(text, { pending: true })).transitions.endConversation, undefined, text);
  }
});

test('el consentimiento ya aceptado deja pasar a la siguiente política', () => {
  assert.deepEqual(consentPolicy(turn('Hola', { status: 'ACCEPTED', pending: true })), {});
});

test('admite una interpretación opcional explícita sin depender del estado pendiente', () => {
  assert.deepEqual(consentPolicy(turn('', { pending: true, interpretation: { consentDecision: 'ACCEPTED' } })), {
    mutations: { fieldsToPersist: { dataConsentStatus: 'ACCEPTED' } }
  });
  assert.deepEqual(consentPolicy(turn('', { interpretation: { consentDecision: 'ACCEPTED' } })), {
    mutations: { fieldsToPersist: { dataConsentStatus: 'ACCEPTED' } }
  });
  assert.equal(consentPolicy(turn('', { interpretation: { consentDecision: 'REVOKED' } })).transitions.endConversation, true);
});
