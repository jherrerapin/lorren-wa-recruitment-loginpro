import {
  DATA_CONSENT_TEXT,
  DATA_CONSENT_VERSION,
  buildConsentAcceptedReply,
  buildConsentPendingMode,
  buildVacancyQuestionReply,
  deriveConsentResumeUpdate,
  evaluateConsentBoundary,
  parseConsentPendingMode
} from '../../src/services/dataConsentGate.js';
import {
  ContextualAllowedAction,
  evaluateContextualResponseGate
} from '../../src/services/contextualResponseGate.js';
import { applyFieldPolicy } from '../../src/services/policyLayer.js';

const CONSENT_SOURCE = 'WHATSAPP_CANDIDATE';
const CONSENT_ACTOR = 'candidate_whatsapp';
const PRE_CONSENT_CV_RESEND_MODE = 'pre_consent_cv_resend';
const PROTECTED_ATTACHMENT_BOUNDARY_REASONS = new Set([
  'attachment_before_consent',
  'capture_mode_without_consent',
  'consent_pending',
  'consent_revoked'
]);
const CONSENT_REVOKED_REPLY = 'Entendido. No continuaré con la postulación ni procesaré tus datos por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';
const PRE_CONSENT_ATTACHMENT_REPLY = 'Recibí que intentaste enviar un archivo, pero todavía no lo descargué ni lo guardé. Antes de recibir datos, hojas de vida o documentos necesito tu autorización para el tratamiento de datos.';
const CONSENT_PROMPT = `Antes de recibir o guardar datos personales, hojas de vida o documentos, necesito tu autorización para tratarlos con fines de reclutamiento de LoginPro.\n\n${DATA_CONSENT_TEXT}\n\nPuedes responder de forma natural si autorizas o si no autorizas.`;

function fixtureNow(fixture) {
  return fixture.executionContext?.now || '2026-07-14T15:00:00.000Z';
}

function buildInboundMessage(fixture) {
  const interactiveBody = String(fixture.inbound.body || '');
  return {
    id: fixture.inbound.messageId,
    from: 'TEST-PHONE-REPLAY',
    type: fixture.inbound.type,
    text: fixture.inbound.type === 'text' ? { body: fixture.inbound.body } : undefined,
    interactive: fixture.inbound.type === 'interactive'
      ? { button_reply: { id: interactiveBody, title: interactiveBody } }
      : undefined,
    document: fixture.inbound.type === 'document' ? structuredClone(fixture.inbound.attachment || {}) : undefined,
    image: fixture.inbound.type === 'image' ? structuredClone(fixture.inbound.attachment || {}) : undefined
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
    evidence: { consentBoundary: boundary, consentPrompt: CONSENT_PROMPT }
  };
}

function buildConsentCandidateUpdate(fixture, state, status) {
  const accepted = status === 'ACCEPTED';
  const now = fixtureNow(fixture);
  const pendingContext = parseConsentPendingMode(state.candidate.botResumeMode);
  const resumeUpdate = accepted ? deriveConsentResumeUpdate(pendingContext.resumeMode) : {};

  return {
    dataConsentStatus: status,
    dataConsentVersion: DATA_CONSENT_VERSION,
    dataConsentText: DATA_CONSENT_TEXT,
    dataConsentSource: CONSENT_SOURCE,
    dataConsentAcceptedAt: accepted ? now : null,
    dataConsentRevokedAt: accepted ? null : now,
    dataConsentRecordedBy: CONSENT_ACTOR,
    currentStep: accepted ? 'COLLECTING_DATA' : 'DONE',
    status: accepted ? state.candidate.status : 'NUEVO',
    botResumeMode: null,
    lastInboundAt: now,
    ...resumeUpdate
  };
}

function buildConsentEvent(status) {
  return {
    status,
    version: DATA_CONSENT_VERSION,
    text: DATA_CONSENT_TEXT,
    source: CONSENT_SOURCE,
    actorUsername: CONSENT_ACTOR,
    note: status === 'ACCEPTED'
      ? 'Aceptación registrada por respuesta de WhatsApp.'
      : 'Revocatoria registrada por respuesta de WhatsApp.'
  };
}

function planConsentDecision(fixture, state, interpretation) {
  const status = interpretation.consentDecision;
  if (!['ACCEPTED', 'REVOKED'].includes(status)) {
    throw new Error(`${fixture.id}: decisión de consentimiento no soportada: ${status}`);
  }

  const candidateUpdate = buildConsentCandidateUpdate(fixture, state, status);
  Object.assign(state.candidate, candidateUpdate);
  const event = buildConsentEvent(status);
  const actions = [
    {
      type: 'RECORD_DATA_CONSENT',
      data: { status, version: DATA_CONSENT_VERSION, candidateUpdate, event }
    },
    { type: status === 'ACCEPTED' ? 'CONTINUE_DATA_COLLECTION' : 'STOP_APPLICATION' }
  ];
  const allowedWrites = [
    ...Object.keys(candidateUpdate).map((field) => `candidate.${field}`),
    'consentEvent.create'
  ];
  appendOutboundWrites(allowedWrites);

  const consentReply = status === 'ACCEPTED'
    ? buildConsentAcceptedReply(state.candidate, state.vacancy, {
      cvResendRequired: parseConsentPendingMode(fixture.initialState.candidate.botResumeMode).cvResendRequired
    })
    : CONSENT_REVOKED_REPLY;

  return {
    plan: {
      actions,
      allowedWrites,
      nextStep: state.candidate.currentStep
    },
    finalState: buildFinalState(state),
    evidence: { consentDecision: status, consentUpdate: candidateUpdate, consentEvent: event, consentReply }
  };
}

function resolveAttachmentResumeMode(candidate = {}, pendingContext = {}) {
  if (pendingContext.pending) return pendingContext.resumeMode;
  const currentMode = String(candidate.botResumeMode || '').trim() || null;
  return currentMode === PRE_CONSENT_CV_RESEND_MODE ? null : currentMode;
}

function planPreConsentAttachment(fixture, state) {
  const boundary = evaluateConsentBoundary(state.candidate, buildInboundMessage(fixture));
  if (!boundary.block || !PROTECTED_ATTACHMENT_BOUNDARY_REASONS.has(boundary.reason)) {
    throw new Error(`${fixture.id}: el adjunto no quedó protegido por la frontera de consentimiento`);
  }

  const pendingContext = parseConsentPendingMode(state.candidate.botResumeMode);
  const botResumeMode = buildConsentPendingMode({
    resumeMode: resolveAttachmentResumeMode(state.candidate, pendingContext),
    cvResendRequired: true
  });
  state.candidate.botResumeMode = botResumeMode;
  const attachment = fixture.inbound.attachment || {};
  const actions = [
    {
      type: 'REJECT_PRECONSENT_ATTACHMENT',
      data: {
        attachmentKind: fixture.inbound.type,
        fileName: attachment.fileName || null,
        mimeType: attachment.mimeType || null
      }
    },
    { type: 'ASK_DATA_CONSENT' }
  ];
  const allowedWrites = ['candidate.botResumeMode'];
  appendOutboundWrites(allowedWrites);

  return {
    plan: {
      actions,
      allowedWrites,
      nextStep: state.candidate.currentStep
    },
    finalState: buildFinalState(state),
    evidence: {
      consentBoundary: boundary,
      attachment: structuredClone(attachment),
      attachmentReply: PRE_CONSENT_ATTACHMENT_REPLY,
      consentPrompt: CONSENT_PROMPT
    }
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

function planCandidateData(fixture, state, interpretation) {
  const fieldEvidence = fixture.providerStubs.aiResult.extraction.fieldEvidence || {};
  const fieldPolicy = applyFieldPolicy({
    fields: interpretation.providedFields,
    fieldEvidence
  }, state.candidate);
  const persistedFields = fieldPolicy.persistedFields;
  const fieldEntries = Object.entries(persistedFields);
  if (!fieldEntries.length) {
    throw new Error(`${fixture.id}: la política de campos no autorizó ningún dato provisto`);
  }

  Object.assign(state.candidate, persistedFields);
  state.pendingFields = state.pendingFields.filter((field) => !Object.hasOwn(persistedFields, field));
  const actions = [
    { type: 'SAVE_CANDIDATE_FIELDS', data: { fields: persistedFields } },
    { type: 'ACKNOWLEDGE_DATA' }
  ];
  const pendingField = state.pendingFields[0] || null;
  const resumeAction = pendingFieldAction(state);
  if (resumeAction) actions.push(resumeAction);

  const allowedWrites = fieldEntries.map(([field]) => `candidate.${field}`);
  allowedWrites.push('conversation.pendingFields');
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

  if (['document', 'image'].includes(fixture.inbound.type) && state.candidate.dataConsentStatus !== 'ACCEPTED') {
    return planPreConsentAttachment(fixture, state);
  }
  if (interpretation.consentDecision) {
    return planConsentDecision(fixture, state, interpretation);
  }
  if (interpretation.intent === 'CONTINUE_APPLICATION' && state.candidate.dataConsentStatus !== 'ACCEPTED') {
    return planConsentRequest(fixture, state);
  }
  if (interpretation.intent === 'ASK_VACANCY_SCHEDULE') {
    return planVacancyQuestion(fixture, state);
  }
  if (interpretation.intent === 'CORRECT_CANDIDATE_DATA') {
    return planCandidateCorrection(fixture, state, interpretation);
  }
  if (interpretation.intent === 'PROVIDE_CANDIDATE_DATA') {
    return planCandidateData(fixture, state, interpretation);
  }

  throw new Error(`${fixture.id}: intención sin adaptador de planificación: ${interpretation.intent}`);
}
