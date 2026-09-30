import test from 'node:test';
import assert from 'node:assert/strict';
import { consentPolicy } from '../src/core/engine/policies/consentPolicy.js';

function turn(rawText, {
  status = 'PENDING',
  resumeMode = null,
  interpretation,
  vacancy = { id: 'vac-1', role: 'Auxiliar de cargue y descargue', city: 'Bogotá' }
} = {}) {
  return {
    turn: { rawText },
    candidate: {
      facts: {
        dataConsentStatus: status,
        vacancyId: vacancy?.id ?? null,
        botResumeMode: resumeMode
      }
    },
    vacancy,
    pending: { fields: status === 'ACCEPTED' ? [] : ['dataConsent'] },
    execution: { mayReply: true },
    ...(interpretation ? { interpretation } : {})
  };
}

test('un saludo no dispara consentimiento aunque el estado legal sea PENDING', () => {
  assert.deepEqual(consentPolicy(turn('Hola', {
    interpretation: { intent: 'GREETING' }
  })), {});
});

test('interés confirmado después de presentar la vacante abre la autorización con botones', () => {
  const decision = consentPolicy(turn('Sí, me interesa', {
    resumeMode: 'awaiting_vacancy_interest',
    interpretation: { intent: 'APPLY_INTENT' }
  }));

  assert.match(decision.reply.text, /Autorizo a LoginPro a tratar mis datos personales, hoja de vida y documentos/);
  assert.deepEqual(decision.reply.interactiveOptions, [
    { id: 'data_consent:lorren-v2-2026-07-v3:accept', label: 'Sí autorizo' },
    { id: 'data_consent:lorren-v2-2026-07-v3:reject', label: 'No autorizo' }
  ]);
  assert.deepEqual(decision.mutations, {
    fieldsToPersist: { botResumeMode: 'awaiting_data_consent' }
  });
  assert.deepEqual(decision.transitions, { keepCurrentStep: true });
});

test('rechazo de interés cierra amablemente sin tratarlo como rechazo legal', () => {
  const decision = consentPolicy(turn('No, gracias', {
    resumeMode: 'awaiting_vacancy_interest',
    interpretation: { intent: 'DECLINE_PROCESS' }
  }));

  assert.match(decision.reply.text, /Si más adelante te interesa continuar/i);
  assert.deepEqual(decision.mutations, {
    fieldsToPersist: { botResumeMode: null }
  });
  assert.equal(decision.transitions.endConversation, true);
});

test('un sí breve no autoriza hasta que la pregunta legal esté pendiente', () => {
  assert.deepEqual(consentPolicy(turn('Sí')), {});
  assert.deepEqual(consentPolicy(turn('Sí', {
    resumeMode: 'awaiting_vacancy_interest'
  })), {});
  assert.deepEqual(consentPolicy(turn('Sí', {
    resumeMode: 'awaiting_data_consent'
  })), {
    mutations: {
      fieldsToPersist: {
        dataConsentStatus: 'ACCEPTED',
        botResumeMode: null
      }
    }
  });
});

test('una autorización legal explícita acepta sin depender de una frase exacta', () => {
  assert.deepEqual(consentPolicy(turn('Sí, autorizo el tratamiento de mis datos')), {
    mutations: {
      fieldsToPersist: {
        dataConsentStatus: 'ACCEPTED',
        botResumeMode: null
      }
    }
  });
});

test('preguntar qué ocurre al autorizar no se interpreta como consentimiento', () => {
  assert.deepEqual(consentPolicy(turn('¿Si autorizo qué harán con mis datos?', {
    resumeMode: 'awaiting_data_consent'
  })), {});
});

test('rechazo legal explícito cierra y limpia el modo de reanudación', () => {
  const decision = consentPolicy(turn('No autorizo el tratamiento de mis datos', {
    resumeMode: 'awaiting_data_consent'
  }));

  assert.match(decision.reply.text, /No continuaré con la postulación/);
  assert.deepEqual(decision.mutations, {
    fieldsToPersist: { botResumeMode: null }
  });
  assert.equal(decision.transitions.endConversation, true);
});

test('un acuse ambiguo mientras espera consentimiento reitera la pregunta sin aceptar', () => {
  const decision = consentPolicy(turn('Ah bueno', {
    resumeMode: 'awaiting_data_consent',
    interpretation: { intent: 'ACKNOWLEDGEMENT' }
  }));

  assert.equal(decision.mutations, undefined);
  assert.match(decision.reply.text, /Autorizo a LoginPro/);
  assert.deepEqual(decision.reply.interactiveOptions, [
    { id: 'data_consent:lorren-v2-2026-07-v3:accept', label: 'Sí autorizo' },
    { id: 'data_consent:lorren-v2-2026-07-v3:reject', label: 'No autorizo' }
  ]);
});

test('el consentimiento ya aceptado deja pasar a la siguiente política', () => {
  assert.deepEqual(consentPolicy(turn('Hola', {
    status: 'ACCEPTED',
    resumeMode: null
  })), {});
});

test('sin vacante resuelta no abre el consentimiento', () => {
  assert.deepEqual(consentPolicy(turn('Sí, me interesa', {
    vacancy: null,
    resumeMode: 'awaiting_vacancy_interest',
    interpretation: { intent: 'APPLY_INTENT' }
  })), {});
});
