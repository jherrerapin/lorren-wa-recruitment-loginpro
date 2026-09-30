import test from 'node:test';
import assert from 'node:assert/strict';
import { vacancyPolicy } from '../src/core/engine/policies/vacancyPolicy.js';

function input(facts, rawText = '', { pendingFields = [], interpretation } = {}) {
  return {
    turn: { rawText },
    candidate: { facts },
    pending: { fields: pendingFields },
    ...(interpretation ? { interpretation } : {})
  };
}

test('deja continuar una vacante activa que recibe postulaciones', () => {
  assert.deepEqual(vacancyPolicy(input({
    vacancyActive: true,
    vacancyAcceptingApplications: true
  })), {});
});

test('tráfico orgánico pide identificar el volante mediante una directiva pura', () => {
  assert.deepEqual(vacancyPolicy({
    ...input({}),
    vacancy: null
  }), {
    reply: { directive: 'ASK_WHICH_FLYER_SEEN' },
    transitions: { keepCurrentStep: true }
  });
});

test('rol y ciudad ambiguos fuerzan desambiguación sin asignar una vacante', () => {
  const decision = vacancyPolicy({
    ...input({}, 'Auxiliar de bodega en Bogotá', {
      interpretation: {
        intent: 'APPLY_INTENT',
        detectedFields: { roleHint: 'auxiliar de bodega', cityHint: 'Bogotá' }
      }
    }),
    vacancy: null
  });

  assert.deepEqual(decision, {
    reply: {
      directive: 'CLARIFY_VACANCY_SELECTION',
      parameters: { roleHint: 'auxiliar de bodega', cityHint: 'Bogotá' }
    },
    transitions: { keepCurrentStep: true }
  });
});

test('si conoce el cargo pero falta la ciudad pregunta solo por la ciudad', () => {
  const decision = vacancyPolicy({
    ...input({}, 'Auxiliar de cargue y descargue', {
      interpretation: { detectedFields: { roleHint: 'Auxiliar de cargue y descargue' } }
    }),
    vacancy: null
  });

  assert.deepEqual(decision, {
    reply: {
      directive: 'ASK_FOR_VACANCY_CITY',
      parameters: { roleHint: 'Auxiliar de cargue y descargue' }
    },
    transitions: { keepCurrentStep: true }
  });
});

test('ofrece guardar una postulación con el rol y la ciudad de la vacante inactiva', () => {
  const decision = vacancyPolicy(input({
    vacancyActive: false,
    vacancyAcceptingApplications: true,
    vacancyRole: 'Auxiliar de bodega',
    vacancyCity: 'Bogotá'
  }));

  assert.match(decision.reply.text, /vacante de Auxiliar de bodega en Bogotá/);
  assert.match(decision.reply.text, /postulación para futuras aperturas/);
  assert.deepEqual(decision.reply.interactiveOptions, [
    { id: 'pool_consent:accept', label: 'Sí, de acuerdo' },
    { id: 'pool_consent:reject', label: 'No, gracias' }
  ]);
  assert.deepEqual(decision.mutations, { nextStep: 'AWAITING_POOL_CONSENT' });
  assert.deepEqual(decision.transitions, { keepCurrentStep: false });
  assert.equal(decision.transitions.endConversation, undefined);
});

test('acepta el alias acceptingApplications y ofrece el registro futuro', () => {
  const decision = vacancyPolicy(input({
    vacancyActive: true,
    acceptingApplications: false
  }));

  assert.equal(decision.mutations.nextStep, 'AWAITING_POOL_CONSENT');
  assert.equal(decision.transitions.endConversation, undefined);
});

test('guarda la aceptación escrita cuando espera consentimiento para el banco general', () => {
  const decision = vacancyPolicy(input({
    currentStep: 'AWAITING_POOL_CONSENT'
  }, 'Sí, de acuerdo'));

  assert.deepEqual(decision, {
    mutations: {
      fieldsToPersist: { optInGeneralPool: true }
    }
  });
});

test('acepta una interpretación explícita cuando el paso está señalado en pending', () => {
  const decision = vacancyPolicy(input({}, '', {
    pendingFields: ['optInGeneralPool'],
    interpretation: { poolConsentDecision: 'ACCEPTED' }
  }));

  assert.deepEqual(decision, {
    mutations: {
      fieldsToPersist: { optInGeneralPool: true }
    }
  });
});

test('finaliza con la despedida legacy solo cuando el candidato rechaza', () => {
  const decision = vacancyPolicy(input({
    currentStep: 'AWAITING_POOL_CONSENT'
  }, 'No, gracias'));

  assert.deepEqual(decision, {
    reply: {
      text: 'Entendido. Si más adelante deseas continuar con la postulación, puedes volver a escribirme y con gusto retomamos el proceso.',
      interactiveOptions: []
    },
    transitions: { endConversation: true }
  });
});

test('no inventa una decisión ante una respuesta ambigua', () => {
  assert.deepEqual(vacancyPolicy(input({
    currentStep: 'AWAITING_POOL_CONSENT'
  }, '¿Qué datos guardarían?')), {});
});

test('un acuse pasivo no autoriza el banco de talento y reitera la decisión pendiente', () => {
  const decision = vacancyPolicy(input({
    currentStep: 'AWAITING_POOL_CONSENT',
    vacancyRole: 'Auxiliar de bodega',
    vacancyCity: 'Bogotá'
  }, 'Ah bueno', {
    interpretation: { intent: 'ACKNOWLEDGEMENT' }
  }));

  assert.equal(decision.mutations, undefined);
  assert.equal(decision.transitions.endConversation, undefined);
  assert.equal(decision.transitions.keepCurrentStep, true);
  assert.match(decision.reply.text, /confirmes si deseas.*futuras aperturas/i);
  assert.deepEqual(decision.reply.interactiveOptions, [
    { id: 'pool_consent:accept', label: 'Sí, de acuerdo' },
    { id: 'pool_consent:reject', label: 'No, gracias' }
  ]);
});

test('no inventa cierre cuando la envoltura todavía no cargó los booleanos', () => {
  assert.deepEqual(vacancyPolicy(input({})), {});
  assert.deepEqual(vacancyPolicy(input({ vacancyActive: true })), {});
});
