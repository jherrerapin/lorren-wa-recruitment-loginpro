import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContextualAllowedAction,
  evaluateContextualResponseGate,
  getLastOutboundContext,
  inferContextualSemanticIntent,
  isManualOutboundSource
} from '../src/services/contextualResponseGate.js';
import { hasRecentHumanIntervention } from '../src/services/conversationEngine.js';

function completeCandidate(overrides = {}) {
  return {
    id: 'cand-1',
    phone: '573001112233',
    vacancyId: 'vac-1',
    currentStep: 'DONE',
    fullName: 'Laura Pérez',
    documentType: 'CC',
    documentNumber: '10101010',
    age: 28,
    locality: 'Bosa',
    medicalRestrictions: 'Sin restricciones medicas',
    transportMode: 'Bus',
    cvStorageKey: 'cv/laura.pdf',
    cvMimeType: 'application/pdf',
    cvOriginalName: 'laura.pdf',
    ...overrides
  };
}

function vacancy(overrides = {}) {
  return {
    id: 'vac-1',
    title: 'Auxiliar logístico',
    role: 'Auxiliar logístico',
    city: 'Bogotá',
    operationAddress: 'Zona industrial',
    interviewAddress: 'Calle 80 # 10-20',
    requiredDocuments: 'Cédula original',
    requirements: 'Experiencia en bodega',
    conditions: 'Turnos rotativos',
    schedulingEnabled: false,
    isActive: true,
    acceptingApplications: true,
    ...overrides
  };
}

function manualOutbound(overrides = {}) {
  return {
    direction: 'OUTBOUND',
    body: 'Mensaje del reclutador',
    rawPayload: { source: 'admin_outbound', actor: 'RECRUITER', sourceCategory: 'MANUAL_AUTHORIZED' },
    createdAt: new Date('2026-05-16T13:00:00.000Z'),
    ...overrides
  };
}


function outboundWithRaw(rawPayload = {}, overrides = {}) {
  return {
    direction: 'OUTBOUND',
    body: 'Outbound',
    rawPayload,
    createdAt: new Date('2026-05-16T13:00:00.000Z'),
    ...overrides
  };
}

const manualSourceCases = [
  ['sin source por compatibilidad', {}, true, 'RECRUITER'],
  ['admin_*', { source: 'admin_manual_vacancy_info' }, true, 'RECRUITER'],
  ['manual_*', { source: 'manual_followup' }, true, 'RECRUITER'],
  ['MANUAL_AUTHORIZED', { source: 'MANUAL_AUTHORIZED' }, true, 'RECRUITER'],
  ['reminder*', { source: 'reminder_interview' }, false, 'REMINDER'],
  ['system*', { source: 'system_notification' }, false, 'SYSTEM'],
  ['source bot normal', { source: 'bot_flow' }, false, 'BOT'],
  ['actor RECRUITER gana sobre source ambiguo', { source: 'bot_flow', actor: 'RECRUITER' }, true, 'RECRUITER']
];

test('política manual source clasifica fuentes humanas y automáticas de forma compatible', () => {
  for (const [label, rawPayload, expectedManual, expectedActor] of manualSourceCases) {
    const context = getLastOutboundContext([outboundWithRaw(rawPayload)]);

    assert.equal(context.isManual, expectedManual, label);
    assert.equal(context.actor, expectedActor, label);
  }
});

test('hasRecentHumanIntervention y getLastOutboundContext clasifican igual manual source', () => {
  for (const [label, rawPayload, expectedManual] of manualSourceCases) {
    const recentMessages = [outboundWithRaw(rawPayload)];
    assert.equal(hasRecentHumanIntervention(recentMessages), expectedManual, label);
    assert.equal(getLastOutboundContext(recentMessages).isManual, expectedManual, label);
  }
});

test('candidato citado + último outbound manual + cierre contextual no reabre flujo', () => {
  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'SCHEDULED' }),
    vacancy: vacancy({ schedulingEnabled: true }),
    activeInterviewBooking: { id: 'booking-1', status: 'SCHEDULED', scheduledAt: new Date('2026-05-16T20:00:00.000Z') },
    recentMessages: [manualOutbound()],
    semanticIntent: 'ACKNOWLEDGEMENT'
  });

  assert.equal(result.shouldReply, false);
  assert.equal(result.allowedAction, ContextualAllowedAction.NO_REPLY);
  assert.match(result.reason, /manually authorized|active appointment/i);
});

test('candidato citado pregunta contacto configurado y responde solo desde contexto asignado', () => {
  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'SCHEDULED' }),
    vacancy: vacancy({ schedulingEnabled: true, interviewContactPerson: 'María en recepción' }),
    activeInterviewBooking: { id: 'booking-1', status: 'SCHEDULED', scheduledAt: new Date('2026-05-16T20:00:00.000Z') },
    recentMessages: [],
    semanticIntent: 'ASK_INTERVIEW_CONTACT_PERSON'
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.requiresHumanReview, false);
  assert.equal(result.allowedAction, ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT);
  assert.match(result.reply, /María en recepción/);
});

test('candidato citado pregunta contacto sin dato configurado: no inventa, responde seguro y exige revisión interna', () => {
  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'SCHEDULED' }),
    vacancy: vacancy({ schedulingEnabled: true, interviewContactPerson: null, contactPerson: null }),
    activeInterviewBooking: { id: 'booking-1', status: 'SCHEDULED', scheduledAt: new Date('2026-05-16T20:00:00.000Z') },
    recentMessages: [],
    semanticIntent: 'ASK_INTERVIEW_CONTACT_PERSON'
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.CREATE_INTERNAL_REVIEW_AND_SAFE_REPLY);
  assert.match(result.reply, /no tengo confirmado (?:ese dato|el nombre de la persona)/i);
  assert.doesNotMatch(result.reply, /humano|revisar[aá] el chat/i);
});

test('pregunta por documentos de entrevista responde natural sin decir configurados', () => {
  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'SCHEDULED' }),
    vacancy: vacancy({
      schedulingEnabled: true,
      requiredDocuments: 'Hoja de vida preferiblemente Formato Minerva 1003 o impresa, como la tengas y Cedula Original'
    }),
    activeInterviewBooking: { id: 'booking-1', status: 'SCHEDULED', scheduledAt: new Date('2026-05-16T20:00:00.000Z') },
    recentMessages: [],
    semanticIntent: 'ASK_REQUIRED_DOCUMENTS'
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT);
  assert.match(result.reply, /Para la entrevista, lleva Hoja de vida preferiblemente Formato Minerva 1003 o impresa, como la tengas y Cedula Original\./i);
  assert.doesNotMatch(result.reply, /configurad/i);
});

test('candidato citado con mensaje ambiguo no recibe oferta ni avance falso', () => {
  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'SCHEDULED' }),
    vacancy: vacancy({ schedulingEnabled: true }),
    activeInterviewBooking: { id: 'booking-1', status: 'CONFIRMED', scheduledAt: new Date('2026-05-16T20:00:00.000Z') },
    recentMessages: [],
    semanticIntent: 'UNCLEAR'
  });

  assert.equal(result.shouldReply, false);
  assert.equal(result.allowedAction, ContextualAllowedAction.NO_REPLY);
});

test('vacante CV_ONLY completa no agenda ni vuelve a pedir HV ante cierre', () => {
  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'DONE' }),
    vacancy: vacancy({ schedulingEnabled: false }),
    activeInterviewBooking: null,
    recentMessages: [],
    semanticIntent: 'ACKNOWLEDGEMENT'
  });

  assert.equal(result.shouldReply, false);
  assert.equal(result.allowedAction, ContextualAllowedAction.NO_REPLY);
});

test('vacante CV_ONLY completa responde estado desde el proceso persistido sin reabrir el motor', () => {
  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'DONE' }),
    vacancy: vacancy({ schedulingEnabled: false }),
    activeInterviewBooking: null,
    recentMessages: [],
    semanticIntent: 'ASK_APPLICATION_STATUS'
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT);
  assert.equal(result.responsePurpose, 'LOGISTICS_ANSWER');
  assert.equal(result.metadata.postCompletionContext, true);
  assert.match(result.reply, /postulación continúa registrada|proceso sigue/i);
});

test('estado completo con dato repetido continúa al motor para decidir corrección sin reabrir desde el gate', () => {
  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'DONE' }),
    vacancy: vacancy({ schedulingEnabled: false }),
    activeInterviewBooking: null,
    recentMessages: [],
    semanticIntent: 'PROVIDE_EXTRA_DATA'
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.CONTINUE_FLOW);
  assert.equal(result.responsePurpose, 'FLOW');
});

test('sin vacante asignada bloquea flujo principal y obliga resolución de vacante', () => {
  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ vacancyId: null, currentStep: 'COLLECTING_DATA' }),
    vacancy: null,
    activeInterviewBooking: null,
    recentMessages: [],
    semanticIntent: 'ACKNOWLEDGEMENT'
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.ASK_VACANCY_CONFIRMATION);
});

test('último mensaje BOT vs RECRUITER cambia política para cierre contextual', () => {
  const base = {
    candidate: completeCandidate({ currentStep: 'DONE' }),
    vacancy: vacancy({ schedulingEnabled: false }),
    activeInterviewBooking: null,
    semanticIntent: 'ACKNOWLEDGEMENT'
  };

  const afterBot = evaluateContextualResponseGate({
    ...base,
    recentMessages: [{ direction: 'OUTBOUND', body: 'Bot', rawPayload: { source: 'bot_flow', actor: 'BOT' } }]
  });
  const afterRecruiter = evaluateContextualResponseGate({
    ...base,
    recentMessages: [manualOutbound()]
  });

  assert.equal(afterBot.shouldReply, false);
  assert.equal(afterRecruiter.shouldReply, false);
  assert.match(afterRecruiter.reason, /recruiter|manually authorized/i);
});

test('clasificación contextual convierte señales existentes en intenciones estructuradas sin decidir estado', () => {
  assert.equal(inferContextualSemanticIntent({ interviewIntent: 'confirm_attendance' }), 'CONFIRM_ATTENDANCE');
  assert.equal(inferContextualSemanticIntent({ resolvedIntent: 'post_completion_ack' }), 'ACKNOWLEDGEMENT');
  assert.equal(inferContextualSemanticIntent({ resolvedIntent: 'cv_intent' }), 'SEND_CV');
});

test('fuentes manuales autorizadas se distinguen de salidas automáticas', () => {
  assert.equal(isManualOutboundSource('admin_outbound'), true);
  assert.equal(isManualOutboundSource('admin_manual_vacancy_info'), true);
  assert.equal(isManualOutboundSource('bot_flow'), false);
});

test('pregunta contextual no respondible con la cita activa se escala y responde seguro sin inventar', () => {
  const semanticIntent = inferContextualSemanticIntent({
    text: '¿Solo hay entrevistas a las 10 o hay más después de las 10?',
    isQuestion: true
  });
  assert.equal(semanticIntent, 'ASK_INTERVIEW_AVAILABILITY');

  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'SCHEDULED' }),
    vacancy: vacancy({ schedulingEnabled: true }),
    activeInterviewBooking: { id: 'booking-1', status: 'SCHEDULED', scheduledAt: new Date('2026-05-16T15:00:00.000Z') },
    recentMessages: [],
    semanticIntent
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.CREATE_INTERNAL_REVIEW_AND_SAFE_REPLY);
  assert.match(result.reason, /not answerable|human validation/i);
  assert.match(result.reply, /no tengo confirmados horarios adicionales/i);
});

test('reporte de inconveniente para llegar a cita activa se escala y responde seguro sin dejar al candidato en silencio', () => {
  const semanticIntent = inferContextualSemanticIntent({
    text: 'Ola buenos días 👋 Que pena tuve un inconveniente, no conozco muy bien la ciudad, me tocó transbordar y me perdí',
    isQuestion: false
  });
  assert.equal(semanticIntent, 'REPORT_ARRIVAL_PROBLEM');

  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'SCHEDULED' }),
    vacancy: vacancy({ schedulingEnabled: true }),
    activeInterviewBooking: { id: 'booking-1', status: 'SCHEDULED', scheduledAt: new Date('2026-05-16T15:00:00.000Z') },
    recentMessages: [],
    semanticIntent
  });

  assert.equal(result.shouldReply, true);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.allowedAction, ContextualAllowedAction.CREATE_INTERNAL_REVIEW_AND_SAFE_REPLY);
  assert.match(result.reason, /arrival issue|human validation/i);
  assert.match(result.reply, /no veo un dato adicional confirmado|responderte con precisión/i);
});

test('estados de confirmación y CV conservan acción pendiente aunque el perfil ya esté completo', () => {
  for (const currentStep of ['CONFIRMING_DATA', 'ASK_CV']) {
    const result = evaluateContextualResponseGate({
      candidate: completeCandidate({ currentStep }),
      vacancy: vacancy({ schedulingEnabled: true }),
      activeInterviewBooking: null,
      recentMessages: [],
      semanticIntent: 'ACKNOWLEDGEMENT'
    });

    assert.equal(result.shouldReply, true, currentStep);
    assert.equal(result.allowedAction, ContextualAllowedAction.CONTINUE_FLOW, currentStep);
  }
});

test('seguimiento natural después de postularse se clasifica y responde desde estado persistido', () => {
  const semanticIntent = inferContextualSemanticIntent({
    text: 'Yo me había postulado para un empleo con ustedes y quisiera saber qué ha pasado',
    isQuestion: true
  });
  assert.equal(semanticIntent, 'ASK_APPLICATION_STATUS');

  const result = evaluateContextualResponseGate({
    candidate: completeCandidate({ currentStep: 'DONE' }),
    vacancy: vacancy({ schedulingEnabled: false }),
    activeInterviewBooking: null,
    recentMessages: [],
    semanticIntent
  });
  assert.equal(result.allowedAction, ContextualAllowedAction.ANSWER_FROM_ASSIGNED_CONTEXT);
  assert.match(result.reply, /postulación continúa registrada|proceso sigue/i);
});

