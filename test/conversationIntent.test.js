import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeConversationTurn,
  detectConversationIntent,
  isPostCompletionAck
} from '../src/services/conversationIntent.js';
import {
  ContextualAllowedAction,
  evaluateContextualResponseGate,
  inferContextualSemanticIntent
} from '../src/services/contextualResponseGate.js';
import {
  PAUSED_VACANCY_OFFER_MODE,
  VacancyFirstGateAction,
  resolveVacancyFirstGate
} from '../src/services/vacancyFirstGate.js';

test('detecta intención apply y faq', () => {
  assert.equal(detectConversationIntent('me interesa continuar con la vacante'), 'apply_intent');
  assert.equal(detectConversationIntent('cuando es la entrevista?'), 'faq');
});

test('detecta confirmaciones y correcciones en contexto', () => {
  assert.equal(detectConversationIntent('si, todo está correcto', { currentStep: 'CONFIRMING_DATA' }), 'confirmation_yes');
  assert.equal(detectConversationIntent('no, corrijo el barrio', { currentStep: 'CONFIRMING_DATA' }), 'confirmation_no_or_correction');
});

test('saludo puro solo inicia saludo con contexto inicial explícito', () => {
  assert.equal(detectConversationIntent('hola', { currentStep: 'MENU' }), 'greeting');
  assert.equal(detectConversationIntent('hola', { isInitialContact: true }), 'greeting');
  assert.equal(detectConversationIntent('hola'), 'provide_data');
  assert.equal(detectConversationIntent('hola', { currentStep: 'COLLECTING_DATA' }), 'provide_data');
  assert.equal(detectConversationIntent('hola', { currentStep: 'DONE', isDoneStep: true }), 'post_completion_ack');
});

test('saludo con contenido no tapa datos ni preguntas posteriores', () => {
  assert.equal(detectConversationIntent('hola mi cedula es 1234567890', { currentStep: 'COLLECTING_DATA' }), 'provide_data');
  assert.equal(detectConversationIntent('hola cuanto pagan?', { currentStep: 'COLLECTING_DATA' }), 'faq');
});

test('detecta agradecimiento post cierre', () => {
  assert.equal(detectConversationIntent('ok gracias', { isDoneStep: true }), 'post_completion_ack');
  assert.equal(isPostCompletionAck('bien gracias'), true);
});

test('detecta intención de CV y fallback a provide_data', () => {
  assert.equal(detectConversationIntent('te envío mi hoja de vida'), 'cv_intent');
  assert.equal(detectConversationIntent('CC 1234567890, barrio jordán'), 'provide_data');
});

test('analiza una pregunta e interés como actos simultáneos y accionables', () => {
  const turn = analyzeConversationTurn(
    'Pero me podrías regalar información sobre esa vacante porque estoy interesado',
    { currentStep: 'GREETING_SENT' }
  );

  assert.equal(turn.question, true);
  assert.equal(turn.vacancyInformationRequest, true);
  assert.equal(turn.interest, true);
  assert.equal(turn.actionable, true);
  assert.equal(turn.maySuppress, false);
});

test('una aceptación natural sigue siendo confirmación accionable', () => {
  for (const text of ['dale', 'de una', 'quiero continuar', 'me interesa']) {
    const turn = analyzeConversationTurn(text, { currentStep: 'GREETING_SENT' });
    assert.equal(turn.confirmation, true, text);
    assert.equal(turn.actionable, true, text);
    assert.equal(turn.maySuppress, false, text);
  }
});

test('un acuse puramente pasivo puede silenciarse cuando no añade una acción', () => {
  const turn = analyzeConversationTurn('ok gracias', { currentStep: 'GREETING_SENT' });

  assert.equal(turn.passiveAcknowledgement, true);
  assert.equal(turn.actionable, false);
  assert.equal(turn.maySuppress, true);
});

test('confirmación o corrección en paso crítico se reserva para la transición determinística', () => {
  assert.equal(
    analyzeConversationTurn('sí, todo está correcto', { currentStep: 'CONFIRMING_DATA' }).reserveForDeterministicState,
    true
  );
  assert.equal(
    analyzeConversationTurn('no, corrijo la localidad', { currentStep: 'CONFIRMING_DATA' }).reserveForDeterministicState,
    true
  );
});

test('distingue una pregunta ordinaria de vacante de una consulta de estado', () => {
  assert.equal(inferContextualSemanticIntent({
    text: '¿Me puedes contar los requisitos de la vacante?',
    resolvedIntent: 'info_request',
    isQuestion: true
  }), 'ASK_VACANCY_INFORMATION');

  assert.equal(inferContextualSemanticIntent({
    text: '¿Cómo va mi proceso?',
    resolvedIntent: 'faq',
    isQuestion: true
  }), 'ASK_APPLICATION_STATUS');
});

const completedReadiness = {
  missingFields: [],
  hasValidCv: true,
  readyForDone: true,
  coreDataComplete: true
};
const scheduledCandidate = {
  id: 'candidate-test',
  vacancyId: 'vacancy-test',
  currentStep: 'SCHEDULED',
  status: 'REGISTRADO'
};
const scheduledVacancy = {
  id: 'vacancy-test',
  title: 'Auxiliar de Cargue y Descargue',
  schedulingEnabled: true,
  requiredDocuments: null
};
const activeBooking = {
  id: 'booking-test',
  status: 'SCHEDULED',
  scheduledAt: new Date('2026-07-20T15:00:00.000Z')
};

test('consulta normal de estado se responde con la cita conocida sin transferir a un asesor', () => {
  const result = evaluateContextualResponseGate({
    candidate: scheduledCandidate,
    vacancy: scheduledVacancy,
    activeInterviewBooking: activeBooking,
    semanticIntent: 'ASK_APPLICATION_STATUS',
    readiness: completedReadiness,
    hasPendingAction: false
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT);
  assert.equal(result.requiresHumanReview, false);
  assert.match(result.reply, /entrevista sigue registrada/i);
});

test('pregunta ordinaria de vacante continúa al respondedor del contexto sin transferencia', () => {
  const result = evaluateContextualResponseGate({
    candidate: scheduledCandidate,
    vacancy: scheduledVacancy,
    activeInterviewBooking: activeBooking,
    semanticIntent: 'ASK_VACANCY_INFORMATION',
    readiness: completedReadiness,
    hasPendingAction: false
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.CONTINUE_FLOW);
  assert.equal(result.requiresHumanReview, false);
});

test('dato logístico no configurado produce respuesta segura sin transferencia automática', () => {
  const result = evaluateContextualResponseGate({
    candidate: scheduledCandidate,
    vacancy: scheduledVacancy,
    activeInterviewBooking: activeBooking,
    semanticIntent: 'ASK_INTERVIEW_CONTACT_PERSON',
    readiness: completedReadiness,
    hasPendingAction: false
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT);
  assert.equal(result.requiresHumanReview, false);
  assert.match(result.reply, /no tengo confirmado el nombre/i);
});

test('problema operativo de llegada conserva la revisión humana', () => {
  const result = evaluateContextualResponseGate({
    candidate: scheduledCandidate,
    vacancy: scheduledVacancy,
    activeInterviewBooking: activeBooking,
    semanticIntent: 'REPORT_ARRIVAL_PROBLEM',
    readiness: completedReadiness,
    hasPendingAction: false
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.CREATE_INTERNAL_REVIEW_AND_SAFE_REPLY);
  assert.equal(result.requiresHumanReview, true);
});

function inactiveVacancyFixture() {
  return {
    id: 'vacancy-inactive',
    title: 'Auxiliar de Cargue y Descargue',
    role: 'Auxiliar de cargue y descargue',
    city: 'Bogota',
    operation: { id: 'operation-bogota', name: 'Operación Bogotá', city: { id: 'city-bogota', name: 'Bogota' } },
    roleDescription: 'apoyar el cargue, descargue y organización de mercancía',
    requirements: 'ser mayor de edad y contar con disponibilidad para labores operativas',
    conditions: 'turnos según programación de la operación',
    operationAddress: 'Bogotá',
    isActive: false,
    acceptingApplications: false
  };
}

function futureOfferMessage() {
  return {
    direction: 'OUTBOUND',
    body: 'La vacante no está activa. Puedo dejar tu perfil registrado si lo deseas.',
    createdAt: new Date(),
    rawPayload: {
      source: 'vacancy_first_gate',
      replyKind: 'INACTIVE_VACANCY_FUTURE_PROFILE_OFFER',
      reason: 'VACANCY_NOT_ACTIVE'
    }
  };
}

test('pregunta sobre vacante inactiva se responde antes de retomar la oferta de registro futuro', async () => {
  const inactiveVacancy = inactiveVacancyFixture();
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: {
      id: 'candidate-inactive',
      status: 'NUEVO',
      currentStep: 'GREETING_SENT',
      vacancyId: inactiveVacancy.id,
      botResumeMode: PAUSED_VACANCY_OFFER_MODE
    },
    currentVacancy: inactiveVacancy,
    inboundText: 'Pero me podrías regalar información sobre esa vacante porque estoy interesado',
    currentStep: 'GREETING_SENT',
    recentMessages: [futureOfferMessage()],
    vacancyHints: { allVacancies: [inactiveVacancy], activeVacancies: [] }
  });

  assert.equal(decision.action, VacancyFirstGateAction.REPLY);
  assert.equal(decision.reason, 'VACANCY_NOT_ACTIVE');
  assert.match(decision.reply, /apoyar el cargue, descargue y organización de mercancía/i);
  assert.match(decision.reply, /requisitos registrados/i);
  assert.match(decision.reply, /no está activa para recibir postulaciones/i);
  assert.match(decision.reply, /futuras aperturas/i);
  assert.equal(decision.candidateUpdates.botResumeMode, PAUSED_VACANCY_OFFER_MODE);
});

test('aceptación natural sin pregunta conserva el registro futuro contextual', async () => {
  const inactiveVacancy = inactiveVacancyFixture();
  const decision = await resolveVacancyFirstGate({
    prisma: null,
    candidate: {
      id: 'candidate-inactive',
      status: 'NUEVO',
      currentStep: 'GREETING_SENT',
      vacancyId: inactiveVacancy.id,
      botResumeMode: PAUSED_VACANCY_OFFER_MODE
    },
    currentVacancy: inactiveVacancy,
    inboundText: 'dale',
    currentStep: 'GREETING_SENT',
    recentMessages: [futureOfferMessage()],
    vacancyHints: { allVacancies: [inactiveVacancy], activeVacancies: [] }
  });

  assert.equal(decision.action, VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT);
  assert.equal(decision.reason, 'PAUSED_VACANCY_FUTURE_PROFILE_ACCEPTED');
});
