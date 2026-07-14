import { buildConsentPendingMode } from '../../src/services/dataConsentGate.js';
import { replayFixtureInterpretation } from './interpretationReplay.js';
import { replayFixturePlanning } from './planningReplay.js';

const RESPONSE_ONLY_ACTIONS = new Set([
  'ACKNOWLEDGE_CORRECTION',
  'ANSWER_VACANCY_QUESTION',
  'RESUME_PENDING_FIELD'
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

function composeReply(planningReplay) {
  const parts = [];
  const plan = planningReplay.plan;

  for (const action of plan.actions) {
    if (action.type === 'ASK_DATA_CONSENT') {
      parts.push('Antes de continuar necesito tu autorización para el tratamiento de tus datos personales y hoja de vida con fines de reclutamiento. Puedes responder si autorizas o si no autorizas.');
      continue;
    }
    if (action.type === 'ANSWER_VACANCY_QUESTION') {
      const answer = planningReplay.evidence.vacancyAnswer;
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('vacancy_answer_missing');
      parts.push(answer);
      continue;
    }
    if (action.type === 'ACKNOWLEDGE_CORRECTION') {
      parts.push(correctionAcknowledgement(plan));
      continue;
    }
    if (action.type === 'RESUME_PENDING_FIELD') {
      parts.push(pendingFieldPrompt(action.data.field));
    }
  }

  return parts.join('\n\n').trim();
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
        patch: { botResumeMode: buildConsentPendingMode() },
        source: action.type
      });
      appliedWrites.push('candidate.botResumeMode');
      continue;
    }

    if (action.type === 'UPDATE_CANDIDATE_FIELDS') {
      const fields = action.data.fields;
      for (const field of Object.keys(fields)) assertWriteAllowed(plan, `candidate.${field}`);
      adapters.updateCandidate({
        tenantContext: fixture.tenantContext,
        requestedCandidateId: candidateId,
        patch: fields,
        source: action.type
      });
      appliedWrites.push(...Object.keys(fields).map((field) => `candidate.${field}`));
      continue;
    }

    if (!RESPONSE_ONLY_ACTIONS.has(action.type)) {
      throw new Error(`unsupported_integral_action:${action.type}`);
    }
  }

  return appliedWrites;
}

function persistAndDeliverReply({ fixture, planningReplay, adapters, body, appliedWrites }) {
  const candidateId = fixture.initialState.candidate.candidateId;
  const plan = planningReplay.plan;
  const idempotencyKey = `${fixture.inbound.messageId}:reply:v1`;

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

  const delivered = adapters.deliverOutbound({
    tenantContext: fixture.tenantContext,
    requestedCandidateId: candidateId,
    idempotencyKey,
    body
  });
  if (!delivered) throw new Error(`unexpected_duplicate_delivery:${idempotencyKey}`);

  return idempotencyKey;
}

export async function replayFixtureIntegral(fixture, adapters) {
  const candidateId = fixture.initialState.candidate.candidateId;
  const claimed = adapters.claimInbound({
    tenantContext: fixture.tenantContext,
    policyContext: fixture.policyContext,
    requestedCandidateId: candidateId,
    message: fixture.inbound
  });

  if (!claimed) {
    return {
      duplicate: true,
      interpreted: false,
      planned: false,
      appliedWrites: [],
      reply: null,
      snapshot: adapters.snapshot()
    };
  }

  const interpretationReplay = await replayFixtureInterpretation(fixture);
  const planningReplay = replayFixturePlanning(fixture, interpretationReplay);
  const appliedWrites = executeCandidateActions({ fixture, planningReplay, adapters });
  const reply = composeReply(planningReplay);
  if (!reply) throw new Error(`${fixture.id}: el plan no produjo respuesta saliente`);
  const outboundIdempotencyKey = persistAndDeliverReply({
    fixture,
    planningReplay,
    adapters,
    body: reply,
    appliedWrites
  });

  return {
    duplicate: false,
    interpreted: true,
    planned: true,
    interpretationReplay,
    planningReplay,
    appliedWrites,
    outboundIdempotencyKey,
    reply,
    snapshot: adapters.snapshot()
  };
}
