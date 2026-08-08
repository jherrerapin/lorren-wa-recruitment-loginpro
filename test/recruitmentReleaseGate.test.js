import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContextualAllowedAction,
  evaluateContextualResponseGate,
  inferContextualSemanticIntent
} from '../src/services/contextualResponseGate.js';

function completeCandidate(overrides = {}) {
  return {
    id: 'candidate-release-gate',
    phone: '573001112233',
    vacancyId: 'vac-release-gate',
    currentStep: 'DONE',
    fullName: 'Candidato Release',
    documentType: 'CC',
    documentNumber: '1000000000',
    age: 28,
    locality: 'Suba',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    cvStorageKey: 'cv/release.pdf',
    cvMimeType: 'application/pdf',
    cvOriginalName: 'release.pdf',
    ...overrides
  };
}

const schedulingVacancy = {
  id: 'vac-release-gate',
  title: 'Mensajero Bogotá',
  role: 'Mensajero',
  city: 'Bogotá',
  schedulingEnabled: true,
  isActive: true,
  acceptingApplications: true
};

test('CONFIRMING_DATA y ASK_CV siguen siendo acciones pendientes aunque datos y CV estén completos', () => {
  for (const currentStep of ['CONFIRMING_DATA', 'ASK_CV']) {
    const result = evaluateContextualResponseGate({
      candidate: completeCandidate({ currentStep }),
      vacancy: schedulingVacancy,
      activeInterviewBooking: null,
      recentMessages: [],
      semanticIntent: 'ACKNOWLEDGEMENT'
    });

    assert.equal(result.shouldReply, true, currentStep);
    assert.equal(result.allowedAction, ContextualAllowedAction.CONTINUE_FLOW, currentStep);
  }
});

test('pregunta natural después de postularse se clasifica como consulta de estado', () => {
  const intent = inferContextualSemanticIntent({
    text: 'Yo me había postulado para un empleo con ustedes y quisiera saber qué ha pasado',
    isQuestion: true
  });

  assert.equal(intent, 'ASK_APPLICATION_STATUS');
});
