import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationTurnInputSchema } from '../src/core/contracts/ConversationTurnInputSchema.js';
import { ConversationDecisionSchema } from '../src/core/contracts/ConversationDecisionSchema.js';
import { calculateConversationDecision } from '../src/core/engine/calculateConversationDecision.js';

function validInput(overrides = {}) {
  return {
    turn: {
      id: 'turn-1',
      receivedAt: '2026-09-23T12:00:00.000Z',
      rawText: 'Me llamo Ana'
    },
    candidate: {
      id: 'candidate-1',
      facts: {},
      updatedAt: null
    },
    history: {
      messages: [],
      lastBotQuestion: null
    },
    pending: {
      fields: ['fullName', 'city'],
      actions: []
    },
    execution: {
      mayReply: true,
      mayPersistCandidate: true,
      maySendOutbound: true
    },
    ...overrides
  };
}

function validDecision(reply) {
  return {
    reply,
    mutations: {
      fieldsToPersist: {},
      nextStep: null,
      nextStage: null
    },
    transitions: {
      keepCurrentStep: true,
      handoffToHuman: false,
      endConversation: false
    },
    scheduling: { action: 'none' }
  };
}

test('acepta una interpretación semántica estricta y mantiene sus objetos inmutables', () => {
  const result = ConversationTurnInputSchema.safeParse(validInput({
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      providedFields: { fullName: 'Ana Pérez' },
      detectedFields: { city: 'Bogotá' },
      extractedFields: { confidence: 0.98 }
    }
  }));

  assert.equal(result.success, true);
  assert.equal(Object.isFrozen(result.data), true);
  assert.equal(Object.isFrozen(result.data.interpretation), true);
  assert.equal(Object.isFrozen(result.data.interpretation.providedFields), true);
});

test('interpretation es opcional para conservar los turnos anteriores', () => {
  assert.equal(ConversationTurnInputSchema.safeParse(validInput()).success, true);
});

test('interpretation conserva strict y rechaza propiedades desconocidas', () => {
  const result = ConversationTurnInputSchema.safeParse(validInput({
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      unexpected: true
    }
  }));

  assert.equal(result.success, false);
});

test('acepta una respuesta compuesta únicamente por una directiva', () => {
  const result = ConversationDecisionSchema.safeParse(validDecision({
    directive: 'ASK_MISSING_FIELDS',
    parameters: { missingFields: ['fullName', 'city'] }
  }));

  assert.equal(result.success, true);
  assert.equal(Object.isFrozen(result.data.reply), true);
  assert.equal(Object.isFrozen(result.data.reply.parameters), true);
});

test('conserva compatibilidad con respuestas de texto e interacciones', () => {
  const result = ConversationDecisionSchema.safeParse(validDecision({
    text: '¿En qué ciudad resides?',
    interactiveOptions: []
  }));

  assert.equal(result.success, true);
});

test('rechaza replies vacíos y propiedades no declaradas', () => {
  assert.equal(ConversationDecisionSchema.safeParse(validDecision({})).success, false);
  assert.equal(ConversationDecisionSchema.safeParse(validDecision({
    directive: 'ASK_FOR_CITY',
    executable: () => true
  })).success, false);
});

test('un recordatorio de sistema no puede ser reemplazado por consentimiento o vacante', async () => {
  const decision = await calculateConversationDecision(validInput({
    turn: {
      id: 'system:inactivity:candidate-1:cycle-1',
      receivedAt: '2026-09-24T12:00:00.000Z',
      rawText: '[SYSTEM_EVENT]'
    },
    candidate: {
      id: 'candidate-1',
      facts: {
        phone: '573001112233',
        dataConsentStatus: 'PENDING',
        vacancyActive: false,
        vacancyAcceptingApplications: false
      },
      updatedAt: '2026-09-24T09:00:00.000Z'
    },
    pending: { fields: ['dataConsent', 'cv'], actions: [] },
    interpretation: { intent: 'INACTIVITY_REMINDER' }
  }));

  assert.deepEqual(decision.reply, {
    directive: 'SEND_REMINDER',
    parameters: { reminderType: 'INACTIVITY_REMINDER' }
  });
  assert.deepEqual(decision.mutations.fieldsToPersist, {});
  assert.equal(decision.mutations.nextStep, null);
});

test('una respuesta idéntica a la última pregunta escala el bucle en vez de repetirse', async () => {
  const repeated = 'En este momento la vacante de Auxiliar de bodega en Bogotá no se encuentra activa, pero si deseas podemos dejar tu postulación para futuras aperturas. ¿Estás de acuerdo?';
  const decision = await calculateConversationDecision(validInput({
    turn: {
      id: 'turn-loop-1',
      receivedAt: '2026-09-23T12:00:00.000Z',
      rawText: 'Quiero información'
    },
    candidate: {
      id: 'candidate-loop-1',
      facts: {
        dataConsentStatus: 'ACCEPTED',
        vacancyId: 'vacancy-loop-1',
        vacancyActive: false,
        vacancyAcceptingApplications: false
      },
      updatedAt: null
    },
    history: {
      messages: [{
        role: 'assistant',
        text: repeated,
        occurredAt: '2026-09-23T11:59:00.000Z'
      }],
      lastBotQuestion: repeated
    },
    pending: { fields: [], actions: [] },
    vacancy: {
      id: 'vacancy-loop-1',
      title: 'Auxiliar de bodega',
      role: 'Auxiliar de bodega',
      city: 'Bogotá',
      isActive: false,
      acceptingApplications: false
    }
  }));

  assert.equal(decision.transitions.handoffToHuman, true);
  assert.notEqual(decision.reply.text, repeated);
  assert.match(decision.reply.text, /evitar repetirte/i);
});
