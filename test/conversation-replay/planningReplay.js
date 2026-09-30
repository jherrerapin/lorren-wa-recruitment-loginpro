import {
  DATA_CONSENT_TEXT,
  DATA_CONSENT_VERSION,
  parseConsentPendingMode
} from '../../src/core/contracts/DataConsentContract.js';
import { CONSENT_REQUEST_TEXT } from '../../src/core/contracts/consentDefinition.js';
import { consentPolicy } from '../../src/core/engine/policies/consentPolicy.js';
import { buildVacancyPolicyReply } from '../../src/core/engine/policies/vacancyPolicy.js';
import {
  buildMissingFieldReply,
  getCandidateReadiness
} from '../../src/services/candidateReadiness.js';
import {
  ContextualAllowedAction,
  evaluateContextualResponseGate
} from '../../src/services/contextualResponseGate.js';
import { applyFieldPolicy } from '../../src/services/policyLayer.js';

const CONSENT_SOURCE = 'WHATSAPP_CANDIDATE';
const CONSENT_ACTOR = 'candidate_whatsapp';
const CONSENT_REVOKED_REPLY = 'Entendido. No continuaré con la postulación ni procesaré tus datos por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';
const CONSENT_PROMPT = `Antes de recibir o guardar datos personales, hojas de vida o documentos, necesito tu autorización para tratarlos con fines de reclutamiento de LoginPro.\n\n${DATA_CONSENT_TEXT}\n\nPuedes responder de forma natural si autorizas o si no autorizas.`;

function fixtureNow(fixture) {
  return fixture.executionContext?.now || '2026-07-14T15:00:00.000Z';
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
  const consentDecision = consentPolicy({
    turn: { rawText: String(fixture.inbound.body || '') },
    candidate: { facts: state.candidate },
    pending: { fields: ['dataConsent'] },
    vacancy: { ...state.vacancy, id: state.vacancy.vacancyId },
    interpretation: { intent: 'APPLY_INTENT' },
    execution: { mayReply: true }
  });
  if (consentDecision?.mutations?.fieldsToPersist?.botResumeMode !== 'awaiting_data_consent') {
    throw new Error(`${fixture.id}: la autoridad de consentimiento no bloqueó un turno protegido`);
  }

  state.candidate.botResumeMode = consentDecision.mutations.fieldsToPersist.botResumeMode;
  const allowedWrites = ['candidate.botResumeMode'];
  appendOutboundWrites(allowedWrites);

  return {
    plan: {
      actions: [{ type: 'ASK_DATA_CONSENT' }],
      allowedWrites,
      nextStep: state.candidate.currentStep
    },
    finalState: buildFinalState(state),
    evidence: {
      consentBoundary: { block: true, reason: 'candidate_wants_to_continue' },
      consentPrompt: consentDecision.reply?.text || CONSENT_PROMPT
    }
  };
}

function deriveConsentResumeUpdate() {
  return {
    currentStep: 'COLLECTING_DATA',
    botResumeMode: null
  };
}

function buildConsentAcceptedReply(candidate = {}, vacancy = null) {
  const readiness = getCandidateReadiness(candidate, vacancy, { requireCv: false });
  const prompt = buildMissingFieldReply(readiness);
  return ['Gracias, tu autorización quedó registrada.', prompt].filter(Boolean).join(' ');
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

function planPreConsentAttachment(fixture, state, interpretation) {
  const attachment = fixture.inbound.attachment || {};
  const item = {
    type: fixture.inbound.type || 'document',
    mediaId: attachment.mediaId || attachment.id || null,
    fileName: attachment.fileName || attachment.filename || null,
    mimeType: attachment.mimeType || attachment.mime_type || null,
    caption: fixture.inbound.caption || attachment.caption || null,
    isCv: interpretation?.attachments?.hasCv === true || interpretation?.attachment?.isCv === true
  };
  const allowedWrites = [];
  appendOutboundWrites(allowedWrites);

  return {
    plan: {
      actions: [{
        type: 'functional_core_attachment',
        payload: {
          attachments: { items: [item], hasCv: item.isCv },
          consentStatus: state.candidate.dataConsentStatus || 'PENDING'
        }
      }],
      allowedWrites,
      nextStep: state.candidate.currentStep
    },
    finalState: buildFinalState(state),
    evidence: {
      attachments: { items: [item], hasCv: item.isCv },
      consentStatus: state.candidate.dataConsentStatus || 'PENDING',
      consentPrompt: CONSENT_REQUEST_TEXT
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

  const answer = buildVacancyPolicyReply(state.vacancy, fixture.inbound.body);
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
    return planPreConsentAttachment(fixture, state, interpretation);
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
