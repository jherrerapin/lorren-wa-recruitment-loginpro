import {
  buildConsentPendingMode,
  buildVacancyQuestionReply,
  evaluateConsentBoundary
} from '../../src/services/dataConsentGate.js';
import {
  ContextualAllowedAction,
  evaluateContextualResponseGate
} from '../../src/services/contextualResponseGate.js';
import { applyFieldPolicy } from '../../src/services/policyLayer.js';

function buildInboundMessage(fixture) {
  return {
    id: fixture.inbound.messageId,
    from: 'TEST-PHONE-REPLAY',
    type: fixture.inbound.type,
    text: fixture.inbound.type === 'text' ? { body: fixture.inbound.body } : undefined
  };
}

function clonePlanningState(fixture) {
  return {
    candidate: structuredClone(fixture.initialState.candidate),
    vacancy: structuredClone(fixture.initialState.vacancy),
    pendingFields: [...(fixture.initialState.pendingFields || [])]
  };
}

function appendOutboundWrites(writes) {
  writes.push('candidate.lastOutboundAt', 'message.outbound');
}

function pendingFieldAction(state) {
  const field = state.pendingFields[0] || null;
  return field
    ? { type: 'RESUME_PENDING_FIELD', data: { field } }
    : null;
}

function buildFinalState(state) {
  return {
    ...state.candidate,
    pendingFields: [...state.pendingFields]
  };
}

function planConsentRequest(fixture, state) {
  const boundary = evaluateConsentBoundary(state.candidate, buildInboundMessage(fixture));
  if (!boundary.block) {
    throw new Error(`${fixture.id}: la autoridad de consentimiento no bloqueó un turno protegido`);
  }

  state.candidate.botResumeMode = buildConsentPendingMode();
  const allowedWrites = ['candidate.botResumeMode'];
  appendOutboundWrites(allowedWrites);

  return {
    plan: {
      actions: [{ type: 'ASK_DATA_CONSENT' }],
      allowedWrites,
      nextStep: state.candidate.currentStep
    },
    finalState: buildFinalState(state),
    evidence: { consentBoundary: boundary }
  };
}

function planVacancyQuestion(fixture, state) {
  const pendingField = state.pendingFields[0] || null;
  const contextualDecision = evaluateContextualResponseGate({
    candidate: state.candidate,
    vacancy: state.vacancy,
    recentMessages: fixture.history,
    semanticIntent: 'ASK_VACANCY_INFORMATION',
    hasPendingAction: Boolean(pendingField)
  });
  if (contextualDecision.allowedAction !== ContextualAllowedAction.CONTINUE_FLOW) {
    throw new Error(`${fixture.id}: el gate contextual no permitió responder la pregunta dentro del flujo`);
  }

  const answer = buildVacancyQuestionReply(state.vacancy, fixture.inbound.body);
  if (!answer) {
    throw new Error(`${fixture.id}: la autoridad de vacante no produjo una respuesta sustentada`);
  }

  const actions = [{ type: 'ANSWER_VACANCY_QUESTION' }];
  const resumeAction = pendingFieldAction(state);
  if (resumeAction) actions.push(resumeAction);

  const allowedWrites = [];
  appendOutboundWrites(allowedWrites);

  return {
    plan: {
      actions,
      allowedWrites,
      nextStep: state.candidate.currentStep,
      ...(pendingField ? { pendingField } : {})
    },
    finalState: buildFinalState(state),
    evidence: { contextualDecision, vacancyAnswer: answer }
  };
}

function planCandidateCorrection(fixture, state, interpretation) {
  const fieldEvidence = fixture.providerStubs.aiResult.extraction.fieldEvidence || {};
  const fieldPolicy = applyFieldPolicy({
    fields: interpretation.providedFields,
    fieldEvidence
  }, state.candidate);
  const persistedFields = fieldPolicy.persistedFields;
  const fieldEntries = Object.entries(persistedFields);
  if (!fieldEntries.length) {
    throw new Error(`${fixture.id}: la política de campos no autorizó ninguna corrección`);
  }

  Object.assign(state.candidate, persistedFields);
  const actions = [
    { type: 'UPDATE_CANDIDATE_FIELDS', data: { fields: persistedFields } },
    { type: 'ACKNOWLEDGE_CORRECTION' }
  ];
  const pendingField = state.pendingFields[0] || null;
  const resumeAction = pendingFieldAction(state);
  if (resumeAction) actions.push(resumeAction);

  const allowedWrites = fieldEntries.map(([field]) => `candidate.${field}`);
  appendOutboundWrites(allowedWrites);

  return {
    plan: {
      actions,
      allowedWrites,
      nextStep: state.candidate.currentStep,
      ...(pendingField ? { pendingField } : {})
    },
    finalState: buildFinalState(state),
    evidence: { fieldPolicy }
  };
}

export function replayFixturePlanning(fixture, interpretationReplay) {
  const state = clonePlanningState(fixture);
  const interpretation = interpretationReplay.interpretation;

  if (interpretation.intent === 'CONTINUE_APPLICATION' && state.candidate.dataConsentStatus !== 'ACCEPTED') {
    return planConsentRequest(fixture, state);
  }
  if (interpretation.intent === 'ASK_VACANCY_SCHEDULE') {
    return planVacancyQuestion(fixture, state);
  }
  if (interpretation.intent === 'CORRECT_CANDIDATE_DATA') {
    return planCandidateCorrection(fixture, state, interpretation);
  }

  throw new Error(`${fixture.id}: intención sin adaptador de planificación: ${interpretation.intent}`);
}
