import { replayFixtureInterpretation } from './interpretationReplay.js';
import { replayFixturePlanning } from './planningReplay.js';

const RESPONSE_ONLY_ACTIONS = new Set([
  'ACKNOWLEDGE_CORRECTION',
  'ACKNOWLEDGE_DATA',
  'ANSWER_VACANCY_QUESTION',
  'CONTINUE_DATA_COLLECTION',
  'REJECT_PRECONSENT_ATTACHMENT',
  'RESUME_PENDING_FIELD',
  'STOP_APPLICATION'
]);

const FIELD_LABELS = Object.freeze({
  locality: 'tu localidad',
  neighborhood: 'tu barrio o sector',
  transportMode: 'tu medio de transporte',
  fullName: 'tu nombre completo',
  documentType: 'tu tipo de documento',
  documentNumber: 'tu número de documento',
  age: 'tu edad'
});

const PENDING_FIELD_PROMPTS = Object.freeze({
  locality: '¿En qué localidad resides?',
  neighborhood: '¿En qué barrio o sector resides?',
  transportMode: '¿Cuál es tu medio de transporte?',
  fullName: '¿Cuál es tu nombre completo?',
  documentType: '¿Cuál es tu tipo de documento?',
  documentNumber: '¿Cuál es tu número de documento?',
  age: '¿Cuál es tu edad?'
});

function assertWriteAllowed(plan, writePath) {
  if (!plan.allowedWrites.includes(writePath)) {
    throw new Error(`write_not_allowed:${writePath}`);
  }
}

function fieldLabel(field) {
  return Object.hasOwn(FIELD_LABELS, field) ? FIELD_LABELS[field] : field;
}

function pendingFieldPrompt(field) {
  return Object.hasOwn(PENDING_FIELD_PROMPTS, field)
    ? PENDING_FIELD_PROMPTS[field]
    : `Confírmame por favor ${field}.`;
}

function naturalList(values) {
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} y ${values[1]}`;
  return `${values.slice(0, -1).join(', ')} y ${values.at(-1)}`;
}

function correctionAcknowledgement(plan) {
  const updateAction = plan.actions.find((action) => action.type === 'UPDATE_CANDIDATE_FIELDS');
  if (!updateAction) throw new Error('correction_without_candidate_update');
  const corrections = Object.entries(updateAction.data.fields)
    .map(([field, value]) => `${fieldLabel(field)} a ${value}`);
  return `Gracias, corregí ${naturalList(corrections)}.`;
}

function dataAcknowledgement(plan) {
  const saveAction = plan.actions.find((action) => action.type === 'SAVE_CANDIDATE_FIELDS');
  if (!saveAction) throw new Error('acknowledgement_without_candidate_data');
  const saved = Object.entries(saveAction.data.fields)
    .map(([field, value]) => `${fieldLabel(field)} como ${value}`);
  return `Gracias, registré ${naturalList(saved)}.`;
}

function appendEvidenceReply(parts, value, errorCode) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(errorCode);
  parts.push(value);
}

function composeReply(planningReplay) {
  const parts = [];
  const plan = planningReplay.plan;

  for (const action of plan.actions) {
    if (action.type === 'ASK_DATA_CONSENT') {
      appendEvidenceReply(parts, planningReplay.evidence.consentPrompt, 'consent_prompt_missing');
      continue;
    }
    if (action.type === 'REJECT_PRECONSENT_ATTACHMENT') {
      appendEvidenceReply(parts, planningReplay.evidence.attachmentReply, 'attachment_reply_missing');
      continue;
    }
    if (action.type === 'CONTINUE_DATA_COLLECTION' || action.type === 'STOP_APPLICATION') {
      appendEvidenceReply(parts, planningReplay.evidence.consentReply, 'consent_decision_reply_missing');
      continue;
    }
    if (action.type === 'ANSWER_VACANCY_QUESTION') {
      appendEvidenceReply(parts, planningReplay.evidence.vacancyAnswer, 'vacancy_answer_missing');
      continue;
    }
    if (action.type === 'ACKNOWLEDGE_CORRECTION') {
      parts.push(correctionAcknowledgement(plan));
      continue;
    }
    if (action.type === 'ACKNOWLEDGE_DATA') {
      parts.push(dataAcknowledgement(plan));
      continue;
    }
    if (action.type === 'RESUME_PENDING_FIELD') {
      parts.push(pendingFieldPrompt(action.data.field));
    }
  }

  return parts.join('\n\n').trim();
}

function outboundIdempotencyKey(fixture) {
  return `${fixture.inbound.messageId}:reply:v1`;
}

function executeConsentAction({ fixture, planningReplay, adapters, action, appliedWrites }) {
  const candidateId = fixture.initialState.candidate.candidateId;
  const candidateUpdate = action.data.candidateUpdate;
  for (const field of Object.keys(candidateUpdate)) {
    assertWriteAllowed(planningReplay.plan, `candidate.${field}`);
  }

  adapters.updateCandidate({
    tenantContext: fixture.tenantContext,
    requestedCandidateId: candidateId,
    patch: candidateUpdate,
    source: action.type
  });
  appliedWrites.push(...Object.keys(candidateUpdate).map((field) => `candidate.${field}`));

  assertWriteAllowed(planningReplay.plan, 'consentEvent.create');
  adapters.createConsentEvent({
    tenantContext: fixture.tenantContext,
    requestedCandidateId: candidateId,
    event: action.data.event
  });
  appliedWrites.push('consentEvent.create');
}

function executeCandidateActions({ fixture, planningReplay, adapters }) {
  const candidateId = fixture.initialState.candidate.candidateId;
  const plan = planningReplay.plan;
  const appliedWrites = [];

  for (const action of plan.actions) {
    if (action.type === 'ASK_DATA_CONSENT') {
      assertWriteAllowed(plan, 'candidate.botResumeMode');
      adapters.updateCandidate({
        tenantContext: fixture.tenantContext,
        requestedCandidateId: candidateId,
        patch: { botResumeMode: planningReplay.finalState.botResumeMode },
        source: action.type
      });
      appliedWrites.push('candidate.botResumeMode');
      continue;
    }

    if (action.type === 'RECORD_DATA_CONSENT') {
      executeConsentAction({ fixture, planningReplay, adapters, action, appliedWrites });
      continue;
    }

    if (['UPDATE_CANDIDATE_FIELDS', 'SAVE_CANDIDATE_FIELDS'].includes(action.type)) {
      const fields = action.data.fields;
      for (const field of Object.keys(fields)) assertWriteAllowed(plan, `candidate.${field}`);
      adapters.updateCandidate({
        tenantContext: fixture.tenantContext,
        requestedCandidateId: candidateId,
        patch: fields,
        source: action.type
      });
      appliedWrites.push(...Object.keys(fields).map((field) => `candidate.${field}`));
      if (action.type === 'SAVE_CANDIDATE_FIELDS') {
        assertWriteAllowed(plan, 'conversation.pendingFields');
        adapters.updateConversationPendingFields({
          tenantContext: fixture.tenantContext,
          pendingFields: planningReplay.finalState.pendingFields,
          source: action.type
        });
        appliedWrites.push('conversation.pendingFields');
      }
      continue;
    }

    if (!RESPONSE_ONLY_ACTIONS.has(action.type)) {
      throw new Error(`unsupported_integral_action:${action.type}`);
    }
  }

  return appliedWrites;
}

function commitReply({ fixture, planningReplay, adapters, body, appliedWrites }) {
  const candidateId = fixture.initialState.candidate.candidateId;
  const plan = planningReplay.plan;
  const idempotencyKey = outboundIdempotencyKey(fixture);

  assertWriteAllowed(plan, 'message.outbound');
  const persisted = adapters.persistOutbound({
    tenantContext: fixture.tenantContext,
    policyContext: fixture.policyContext,
    requestedCandidateId: candidateId,
    idempotencyKey,
    body
  });
  if (!persisted) throw new Error(`unexpected_duplicate_outbound:${idempotencyKey}`);
  appliedWrites.push('message.outbound');

  assertWriteAllowed(plan, 'candidate.lastOutboundAt');
  adapters.updateCandidate({
    tenantContext: fixture.tenantContext,
    requestedCandidateId: candidateId,
    patch: { lastOutboundAt: adapters.now },
    source: 'OUTBOUND_PERSISTED'
  });
  appliedWrites.push('candidate.lastOutboundAt');

  return idempotencyKey;
}

function deliverCommittedReply({ fixture, adapters, idempotencyKey, body }) {
  const delivered = adapters.deliverOutbound({
    tenantContext: fixture.tenantContext,
    requestedCandidateId: fixture.initialState.candidate.candidateId,
    idempotencyKey,
    body
  });
  if (!delivered) throw new Error(`unexpected_duplicate_delivery:${idempotencyKey}`);
}

function recoverPendingOutbound(fixture, adapters) {
  const candidateId = fixture.initialState.candidate.candidateId;
  const idempotencyKey = outboundIdempotencyKey(fixture);
  const outbound = adapters.readOutbound({
    tenantContext: fixture.tenantContext,
    idempotencyKey
  });

  if (!outbound) {
    return {
      outboundFound: false,
      recoveryAttempted: false,
      recovered: false,
      reply: null,
      outboundIdempotencyKey: null
    };
  }

  if (adapters.hasDelivery({ tenantContext: fixture.tenantContext, idempotencyKey })) {
    return {
      outboundFound: true,
      recoveryAttempted: false,
      recovered: false,
      reply: null,
      outboundIdempotencyKey: idempotencyKey
    };
  }

  const delivered = adapters.deliverOutbound({
    tenantContext: fixture.tenantContext,
    requestedCandidateId: candidateId,
    idempotencyKey,
    body: outbound.body
  });
  if (!delivered) throw new Error(`pending_outbound_not_recovered:${idempotencyKey}`);

  return {
    outboundFound: true,
    recoveryAttempted: true,
    recovered: true,
    reply: outbound.body,
    outboundIdempotencyKey: idempotencyKey
  };
}

async function processTurn(fixture, adapters, { duplicate, resumedProcessing }) {
  const interpretationReplay = await replayFixtureInterpretation(fixture);
  const planningReplay = replayFixturePlanning(fixture, interpretationReplay);
  const reply = composeReply(planningReplay);
  if (!reply) throw new Error(`${fixture.id}: el plan no produjo respuesta saliente`);

  const appliedWrites = [];
  let outboundIdempotencyKey = null;
  adapters.runInTransaction(() => {
    appliedWrites.push(...executeCandidateActions({ fixture, planningReplay, adapters }));
    outboundIdempotencyKey = commitReply({
      fixture,
      planningReplay,
      adapters,
      body: reply,
      appliedWrites
    });
  });

  deliverCommittedReply({
    fixture,
    adapters,
    idempotencyKey: outboundIdempotencyKey,
    body: reply
  });

  return {
    duplicate,
    resumedProcessing,
    interpreted: true,
    planned: true,
    recoveryAttempted: false,
    recovered: false,
    interpretationReplay,
    planningReplay,
    appliedWrites,
    outboundIdempotencyKey,
    reply,
    snapshot: adapters.snapshot()
  };
}

export async function replayFixtureIntegral(fixture, adapters) {
  const candidateId = fixture.initialState.candidate.candidateId;
  const claimed = adapters.claimInbound({
    tenantContext: fixture.tenantContext,
    policyContext: fixture.policyContext,
    requestedCandidateId: candidateId,
    message: fixture.inbound
  });

  if (claimed) {
    return processTurn(fixture, adapters, { duplicate: false, resumedProcessing: false });
  }

  const recovery = recoverPendingOutbound(fixture, adapters);
  if (recovery.outboundFound) {
    return {
      duplicate: true,
      resumedProcessing: false,
      interpreted: false,
      planned: false,
      appliedWrites: [],
      ...recovery,
      snapshot: adapters.snapshot()
    };
  }

  return processTurn(fixture, adapters, { duplicate: true, resumedProcessing: true });
}
