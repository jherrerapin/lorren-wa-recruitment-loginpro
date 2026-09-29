import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPolicy } from '../src/core/engine/policies/chatPolicy.js';

function input({ intent, providedFields = {}, pendingFields = [] } = {}) {
  return {
    interpretation: { intent, providedFields },
    pending: { fields: pendingFields }
  };
}

test('persiste datos detectados y agrupa todos los campos pendientes', () => {
  assert.deepEqual(chatPolicy(input({
    intent: 'PROVIDE_CANDIDATE_DATA',
    providedFields: { fullName: 'Ana Pérez' },
    pendingFields: ['fullName', 'city', 'documentType']
  })), {
    reply: {
      directive: 'ASK_MISSING_FIELDS',
      parameters: { missingFields: ['city', 'documentType'] }
    },
    mutations: {
      fieldsToPersist: { fullName: 'Ana Pérez' }
    },
    transitions: { keepCurrentStep: true }
  });
});

test('nunca solicita género y sí conserva su detección silenciosa', () => {
  const decision = chatPolicy({
    interpretation: {
      providedFields: { fullName: 'Ana Pérez' },
      detectedFields: { gender: 'FEMALE' }
    },
    pending: { fields: ['gender', 'fullName'] }
  });

  assert.equal(decision.reply, undefined);
  assert.deepEqual(decision.mutations.fieldsToPersist, {
    gender: 'FEMALE',
    fullName: 'Ana Pérez'
  });
});

test('nunca solicita género aunque llegue como campo pendiente', () => {
  const decision = chatPolicy(input({
    intent: 'PROVIDE_CANDIDATE_DATA',
    pendingFields: ['gender', 'fullName']
  }));

  assert.deepEqual(decision.reply.parameters.missingFields, ['fullName']);
  assert.equal(decision.reply.parameters.missingFields.includes('gender'), false);
});

test('persiste varios campos juntos sin emitir preguntas secuenciales', () => {
  assert.deepEqual(chatPolicy(input({
    intent: 'PROVIDE_CANDIDATE_DATA',
    providedFields: {
      fullName: 'Ana Pérez',
      city: 'Bogotá',
      documentNumber: '1000123456'
    },
    pendingFields: ['fullName', 'city', 'documentType', 'documentNumber']
  })), {
    reply: {
      directive: 'ASK_MISSING_FIELDS',
      parameters: { missingFields: ['documentType'] }
    },
    mutations: {
      fieldsToPersist: {
        fullName: 'Ana Pérez',
        city: 'Bogotá',
        documentNumber: '1000123456'
      }
    },
    transitions: { keepCurrentStep: true }
  });
});

test('un campo entregado en el turno deja de formar parte de la solicitud agrupada', () => {
  assert.deepEqual(chatPolicy(input({
    intent: 'PROVIDE_CANDIDATE_DATA',
    providedFields: { transportMode: 'Moto' },
    pendingFields: ['transportMode']
  })), {
    reply: { directive: 'ACKNOWLEDGE_DATA' },
    mutations: {
      fieldsToPersist: { transportMode: 'Moto' }
    }
  });
});

test('el consentimiento pendiente queda reservado para la política legal', () => {
  assert.deepEqual(chatPolicy(input({
    intent: 'ACCEPT_DATA_CONSENT',
    pendingFields: ['dataConsent']
  })), {});
});

test('una pregunta informativa produce una directiva y no una frase estática', () => {
  assert.deepEqual(chatPolicy(input({
    intent: 'ASK_VACANCY_INFORMATION',
    pendingFields: []
  })), {
    reply: { directive: 'ANSWER_VACANCY_INFORMATION' }
  });
});

test('una corrección fuera de la lista pendiente se persiste sin inventar avance', () => {
  assert.deepEqual(chatPolicy(input({
    intent: 'CORRECT_CANDIDATE_DATA',
    providedFields: { age: 28 }
  })), {
    reply: { directive: 'ACKNOWLEDGE_CORRECTION' },
    mutations: { fieldsToPersist: { age: 28 } }
  });
});

test('ignora campos no autorizados y valores no serializables', () => {
  assert.deepEqual(chatPolicy(input({
    intent: 'PROVIDE_CANDIDATE_DATA',
    providedFields: {
      fullName: 'Ana Pérez',
      password: 'secreto',
      age: Number.POSITIVE_INFINITY,
      callback: () => true
    }
  })), {
    reply: { directive: 'ACKNOWLEDGE_DATA' },
    mutations: { fieldsToPersist: { fullName: 'Ana Pérez' } }
  });
});

test('sin interpretación no adivina ninguna decisión', () => {
  assert.deepEqual(chatPolicy({ pending: { fields: ['fullName'] } }), {});
});

test('los eventos del sistema generan recordatorio sin solicitar campos pendientes', () => {
  for (const intent of ['INACTIVITY_REMINDER', 'INTERVIEW_REMINDER']) {
    assert.deepEqual(chatPolicy({
      interpretation: { intent },
      pending: { fields: ['fullName', 'cv'] }
    }), {
      reply: {
        directive: 'SEND_REMINDER',
        parameters: { reminderType: intent }
      }
    });
  }
});

test('una respuesta posterior reactiva el ciclo de inactividad', () => {
  assert.deepEqual(chatPolicy({
    candidate: { facts: { inactivityReminderSent: true } },
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      extractedFields: { age: 27 }
    },
    pending: { fields: ['age'] }
  }).mutations.fieldsToPersist, {
    inactivityReminderSent: false,
    age: 27
  });
});

test('falta de interés o cancelación explícita termina la conversación sin agendar', () => {
  for (const intent of ['CANCEL_APPLICATION', 'STOP_APPLICATION', 'DECLINE_PROCESS']) {
    assert.deepEqual(chatPolicy(input({ intent })), {
      transitions: { endConversation: true }
    });
  }
});

test('mayReply false conserva la captura de datos sin producir respuesta', () => {
  assert.deepEqual(chatPolicy({
    interpretation: {
      intent: 'PROVIDE_CANDIDATE_DATA',
      providedFields: { documentNumber: '1000123456' }
    },
    pending: { fields: ['documentNumber'] },
    execution: { mayReply: false }
  }), {
    mutations: {
      fieldsToPersist: { documentNumber: '1000123456' }
    }
  });
});
