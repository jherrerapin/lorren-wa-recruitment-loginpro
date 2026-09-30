import test from 'node:test';
import assert from 'node:assert/strict';
import { vacancyPolicy } from '../src/core/engine/policies/vacancyPolicy.js';

function input(facts, rawText = '', { pendingFields = [], interpretation } = {}) {
  return {
    turn: { rawText },
    candidate: { facts },
    pending: { fields: pendingFields },
    execution: { mayReply: true },
    ...(interpretation ? { interpretation } : {})
  };
}

function activeVacancy(overrides = {}) {
  return {
    id: 'vac-1',
    title: 'Auxiliar de cargue y descargue',
    role: 'Auxiliar de cargue y descargue',
    city: 'Bogotá',
    isActive: true,
    acceptingApplications: true,
    requirements: 'Bachiller y disponibilidad para labor física',
    conditions: 'Contrato con prestaciones de ley',
    roleDescription: 'Cargue, descargue y organización de mercancía',
    operationAddress: 'Bogotá',
    ...overrides
  };
}

test('deja continuar una vacante activa que recibe postulaciones cuando no hay snapshot cargado', () => {
  assert.deepEqual(vacancyPolicy(input({
    vacancyActive: true,
    vacancyAcceptingApplications: true
  })), {});
});

test('tráfico orgánico sin contexto pregunta ciudad y vacante en una sola intervención', () => {
  assert.deepEqual(vacancyPolicy({
    ...input({}),
    vacancy: null
  }), {
    reply: { directive: 'ASK_CITY_AND_VACANCY' },
    transitions: { keepCurrentStep: true }
  });
});

test('si la ciudad ya es conocida pregunta únicamente la vacante', () => {
  assert.deepEqual(vacancyPolicy({
    ...input({ recruitmentCity: 'Bogotá' }),
    vacancy: null
  }), {
    reply: {
      directive: 'ASK_VACANCY_FOR_CITY',
      parameters: { city: 'Bogotá' }
    },
    transitions: { keepCurrentStep: true }
  });
});

test('si el cargo ya es conocido pregunta únicamente la ciudad', () => {
  assert.deepEqual(vacancyPolicy({
    ...input({ recruitmentRole: 'Auxiliar de cargue y descargue' }),
    vacancy: null
  }), {
    reply: {
      directive: 'ASK_CITY_FOR_ROLE',
      parameters: { role: 'Auxiliar de cargue y descargue' }
    },
    transitions: { keepCurrentStep: true }
  });
});

test('rol y ciudad conocidos pero todavía ambiguos fuerzan desambiguación sin asignar una vacante', () => {
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

test('vacante resuelta presenta solo información configurada y pregunta interés antes del consentimiento', () => {
  const vacancy = activeVacancy();
  const decision = vacancyPolicy({
    ...input({
      vacancyId: vacancy.id,
      recruitmentCity: vacancy.city,
      recruitmentRole: vacancy.role,
      dataConsentStatus: 'PENDING'
    }),
    vacancy
  });

  assert.match(decision.reply.text, /Auxiliar de cargue y descargue en Bogotá/);
  assert.match(decision.reply.text, /Bachiller y disponibilidad para labor física/);
  assert.match(decision.reply.text, /Contrato con prestaciones de ley/);
  assert.match(decision.reply.text, /¿Te interesa continuar con la postulación\?/);
  assert.deepEqual(decision.reply.interactiveOptions, [
    { id: 'vacancy_interest:accept', label: 'Sí, me interesa' },
    { id: 'vacancy_interest:reject', label: 'No, gracias' }
  ]);
  assert.deepEqual(decision.mutations, {
    fieldsToPersist: { botResumeMode: 'awaiting_vacancy_interest' }
  });
});

test('una pregunta fuera del libreto responde y conserva el objetivo de interés', () => {
  const vacancy = activeVacancy();
  const decision = vacancyPolicy({
    ...input({
      vacancyId: vacancy.id,
      dataConsentStatus: 'PENDING',
      botResumeMode: 'awaiting_vacancy_interest'
    }, '¿Cuáles son los requisitos?', {
      interpretation: { intent: 'ASK_VACANCY_REQUIREMENTS' }
    }),
    vacancy
  });

  assert.match(decision.reply.text, /Bachiller y disponibilidad para labor física/);
  assert.match(decision.reply.text, /¿Te interesa continuar con la postulación\?/);
  assert.equal(decision.mutations, undefined);
});

test('no pisa la respuesta de consentimiento cuando ya está esperando interés y llega una respuesta libre', () => {
  const vacancy = activeVacancy();
  assert.deepEqual(vacancyPolicy({
    ...input({
      vacancyId: vacancy.id,
      dataConsentStatus: 'PENDING',
      botResumeMode: 'awaiting_vacancy_interest'
    }, 'Sí, me interesa', {
      interpretation: { intent: 'APPLY_INTENT' }
    }),
    vacancy
  }), {});
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
